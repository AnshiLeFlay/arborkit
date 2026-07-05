import type { Json, NodeId } from "./types";
import { ArtifactTree, type TreeDeps } from "./artifact-tree";
import { Addressing } from "./addressing";
import { EventLog, type MutationEvent } from "./event-log";
import { Mutator } from "./mutator";
import type { VectorIndexPort } from "./vector-index-port";
import { serializeArtifact, restoreArtifact } from "./storage";
import type { DeltaStoragePort } from "./delta-storage";
import { InvalidOpError } from "./errors";

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
 * operation. Node ids for touched subtrees are regenerated; replay/revert are path-addressed and
 * unaffected, but id-addressed views (e.g. toolset `history`, which filters by targetId)
 * may not see a regenerated node's pre-restore history. Malformed/pre-M7 events (missing
 * paths) are skipped.
 */
export function applyEventForward(mutator: Mutator, e: MutationEvent): void {
  switch (e.kind) {
    case "set": {
      if (e.path === undefined) return;
      const opts: { type?: string | null; tags?: string[] } = {};
      if (e.nodeType !== undefined) opts.type = e.nodeType;
      if (e.tags !== undefined) opts.tags = e.tags;
      mutator.set({ path: e.path }, e.after ?? null, opts);
      return;
    }
    case "insert": {
      if (e.path === undefined || e.key === null) return;
      const opts: { type?: string | null; tags?: string[] } = {};
      if (e.nodeType !== undefined) opts.type = e.nodeType;
      if (e.tags !== undefined) opts.tags = e.tags;
      mutator.insert({ path: parentPointer(e.path) }, e.key, e.after ?? null, opts);
      return;
    }
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
 * Throws if events in `[sinceSeq, baseSeq)` were compacted away before being journaled
 * (that history is unrecoverable) — compact only right before `persistCheckpoint`.
 */
export async function persistDelta(store: DeltaStoragePort, log: EventLog, sinceSeq: number): Promise<number> {
  if (sinceSeq < log.baseSeqValue()) {
    throw new InvalidOpError(
      `persistDelta: events [${sinceSeq}, ${log.baseSeqValue()}) were compacted before being journaled`,
    );
  }
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
  await store.writeCheckpoint(await serializeArtifact(tree, log, vectors));
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
  // The journal must continue exactly where the checkpoint ends — a gap means events
  // were lost (torn journal line, or compaction before journaling); replaying past a
  // gap would silently produce a wrong tree, so fail loudly instead.
  const checkpointVersion = (checkpoint.baseSeq ?? 0) + checkpoint.events.length;
  for (let i = 0; i < journal.length; i++) {
    if (journal[i].seq !== checkpointVersion + i) {
      throw new InvalidOpError(
        `restoreFromDelta: journal not contiguous with checkpoint (expected seq ${checkpointVersion + i}, got ${journal[i].seq})`,
      );
    }
  }
  // `restoreArtifact` guards `deps.idGen` against collisions with the checkpoint's node
  // ids and keeps the guard on the returned tree's deps — ids minted while replaying the
  // journal below (and by all later mutations) are collision-safe.
  const { tree } = await restoreArtifact(checkpoint, deps, vectors);
  const addressing = new Addressing(tree);
  const replayLog = new EventLog(); // throwaway — the faithful log is rebuilt below
  // Mutator hooks are synchronous but the vector port is async — queue removals
  // during replay and flush them (awaited) afterwards, so a DB-backed index never
  // gets a fire-and-forget delete.
  const removedIds: NodeId[] = [];
  const mutator = new Mutator(tree, addressing, replayLog, {
    clock: deps.clock,
    onChange: (node) => {
      node.meta.embedding = { state: "stale" };
    },
    onRemove: (id) => {
      removedIds.push(id);
    },
  });
  replayForward(mutator, journal);
  for (const id of removedIds) await vectors.remove(id);
  const log = EventLog.fromStored([...checkpoint.events, ...journal], checkpoint.baseSeq ?? 0);
  return { tree, log };
}
