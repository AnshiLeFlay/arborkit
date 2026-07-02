import type { Json } from "./types";
import { ArtifactTree, type TreeDeps } from "./artifact-tree";
import { Addressing } from "./addressing";
import { EventLog, type MutationEvent } from "./event-log";
import { Mutator } from "./mutator";
import type { VectorIndexPort } from "./vector-index-port";
import { serializeArtifact, restoreArtifact } from "./storage";
import type { DeltaStoragePort } from "./delta-storage";

/** The JSON-Pointer of the parent container of `pointer` ("" = root). Pointer
 *  separators are literal "/"; an in-key "/" is escaped "~1", so lastIndexOf is safe. */
function parentPointer(pointer: string): string {
  const i = pointer.lastIndexOf("/");
  return i <= 0 ? "" : pointer.slice(0, i);
}

/**
 * Re-apply ONE recorded event FORWARD onto a live tree via the `Mutator`, addressed by
 * the event's stable path(s). The inverse of replay's `reverseApplyValue`: set→`after`,
 * insert→insert `after`, remove→remove, move→to. Goes through the Mutator so
 * decomposition, typing (via `e.nodeType`), and the index hooks run exactly as in normal
 * operation. Node ids for touched subtrees are regenerated; the log/replay are
 * path-addressed, so that is invisible to consumers. Malformed/pre-M7 events (missing
 * paths) are skipped.
 */
export function applyEventForward(mutator: Mutator, e: MutationEvent): void {
  switch (e.kind) {
    case "set":
      if (e.path === undefined) return;
      mutator.set({ path: e.path }, e.after ?? null, e.nodeType === undefined ? {} : { type: e.nodeType });
      return;
    case "insert":
      if (e.path === undefined || e.key === null) return;
      mutator.insert(
        { path: parentPointer(e.path) },
        e.key,
        e.after ?? null,
        e.nodeType === undefined ? {} : { type: e.nodeType },
      );
      return;
    case "remove":
      if (e.path === undefined) return;
      mutator.remove({ path: e.path });
      return;
    case "move":
      if (e.fromPath === undefined || e.toPath === undefined || !e.to || e.to.key === null) return;
      mutator.move({ path: e.fromPath }, { path: parentPointer(e.toPath) }, e.to.key);
      return;
  }
}

/** Forward-apply a sequence of events, in order. */
export function replayForward(mutator: Mutator, events: readonly MutationEvent[]): void {
  for (const e of events) applyEventForward(mutator, e);
}

/**
 * Append every event newer than `sinceSeq` to the journal (the cheap, common save).
 * Returns the new high-water seq to pass next time. No-op if nothing is new.
 */
export async function persistDelta(store: DeltaStoragePort, log: EventLog, sinceSeq: number): Promise<number> {
  const fresh = log.since(sinceSeq);
  if (fresh.length > 0) await store.appendEvents(fresh);
  return log.length();
}

/**
 * Write a full checkpoint (replacing the prior one and clearing the journal) and return
 * its high-water seq. Pair with M12 `log.compactTo(...)` BEFORE calling to keep the
 * checkpoint's embedded event window small.
 */
export async function persistCheckpoint(
  store: DeltaStoragePort,
  tree: ArtifactTree,
  log: EventLog,
  vectors: VectorIndexPort,
): Promise<number> {
  await store.writeCheckpoint(serializeArtifact(tree, log, vectors));
  return log.length();
}

/**
 * Restore a tree + log from a checkpoint plus its journaled deltas. Returns null if no
 * checkpoint has been written yet. Forward-replays the journal through a `Mutator` so node
 * TYPES are preserved (via each event's `nodeType`) and UNCHANGED nodes keep their ids and
 * checkpoint vectors; touched nodes are re-decomposed and marked `embedding.state: "stale"`
 * for the consumer's `SemanticIndex` reindex, and removed/orphaned nodes' vectors are
 * dropped. `vectors` should be a fresh index (the checkpoint's vectors are upserted into it).
 * Restore must use the same `decompose` decision as the original run (journal-touched nodes
 * are re-decomposed); replay does not re-validate.
 */
export async function restoreFromDelta(
  store: DeltaStoragePort,
  deps: TreeDeps,
  vectors: VectorIndexPort,
): Promise<{ tree: ArtifactTree; log: EventLog } | null> {
  const { checkpoint, journal } = await store.loadDelta();
  if (!checkpoint) return null;
  // Guard the id generator: `fromStored` preserves the checkpoint's node ids, but
  // `deps.idGen` starts fresh, so ids minted while replaying the journal could collide
  // with restored ids (a collision silently overwrites a live node in the node map and
  // corrupts the parent chain into a cycle — `pathOf` then never terminates). Skip any
  // id already in use; deterministic generators (SeqIdGen) simply advance past them.
  const usedIds = new Set(checkpoint.nodes.map((n) => n.id));
  const guardedDeps: TreeDeps = {
    ...deps,
    idGen: {
      next: () => {
        let id = deps.idGen.next();
        while (usedIds.has(id)) id = deps.idGen.next();
        usedIds.add(id);
        return id;
      },
    },
  };
  const { tree } = restoreArtifact(checkpoint, guardedDeps, vectors);
  const addressing = new Addressing(tree);
  const replayLog = new EventLog(); // throwaway — the faithful log is rebuilt below
  const mutator = new Mutator(tree, addressing, replayLog, {
    clock: deps.clock,
    onChange: (node) => {
      node.meta.embedding = { state: "stale" };
    },
    onRemove: (id) => {
      vectors.remove(id);
    },
  });
  replayForward(mutator, journal);
  const log = EventLog.fromStored([...checkpoint.events, ...journal], checkpoint.baseSeq ?? 0);
  return { tree, log };
}
