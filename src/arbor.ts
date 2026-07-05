import type { Json } from "./types";
import { ArtifactTree, type TreeDeps } from "./artifact-tree";
import { Addressing } from "./addressing";
import { EventLog } from "./event-log";
import { Mutator, type MutatorDeps } from "./mutator";
import { Replay } from "./replay";
import { SemanticIndex } from "./semantic-index";
import { makeToolset, type Toolset, type ToolsetBinding } from "./toolset";
import type { TypeRegistry } from "./type-registry";
import { makeRegistryValidator } from "./registry-validator";
import { typeAwareDecision } from "./type-aware-decision";
import { sizeBasedDecision, type DecomposeDecision } from "./decompose";
import { UuidIdGen, type IdGen } from "./ids";
import { SystemClock, type Clock } from "./clock";
import type { EmbeddingPort } from "./embedding-port";
import { MemoryVectorIndex, type VectorIndexPort } from "./vector-index-port";
import { serializeArtifact, restoreArtifact, type StoragePort } from "./storage";
import { persistCheckpoint, persistDelta, restoreFromDelta } from "./delta";
import type { DeltaStoragePort } from "./delta-storage";
import { InvalidOpError } from "./errors";

/** Everything `createArbor`/`restoreArbor` need. All optional — sensible defaults. */
export interface ArborOpts {
  /** Initial JSON for a fresh artifact (default {}). Ignored by restoreArbor. */
  initial?: Json;
  /** Node types: per-type validation, decompose override, embedText. */
  registry?: TypeRegistry;
  /** Base decompose policy (default sizeBasedDecision(200)); made type-aware when a registry is given. */
  decompose?: DecomposeDecision;
  idGen?: IdGen; // default UuidIdGen — deterministic gens are safe too (restore is guarded)
  clock?: Clock; // default SystemClock
  /** Enables the semantic index (vectors default to MemoryVectorIndex). */
  embedding?: EmbeddingPort;
  vectors?: VectorIndexPort;
  /** Whole-artifact persistence: enables save(); restoreArbor falls back to it. */
  storage?: StoragePort;
  /** Incremental persistence: enables saveDelta()/checkpoint(); restoreArbor prefers it. */
  delta?: DeltaStoragePort;
}

/** A fully wired artifact: the live components plus lifecycle helpers. */
export interface Arbor {
  readonly tree: ArtifactTree;
  readonly addressing: Addressing;
  readonly log: EventLog;
  readonly mutator: Mutator;
  readonly replay: Replay;
  /** Present iff `embedding` was configured. */
  readonly index?: SemanticIndex;
  readonly vectors: VectorIndexPort;
  /** A scoped agent-facing toolset over this artifact. */
  toolset(binding?: ToolsetBinding): Toolset;
  /** Whole-artifact snapshot to `storage`. */
  save(): Promise<void>;
  /** Append events since the last saveDelta/checkpoint to the delta journal. */
  saveDelta(): Promise<void>;
  /** Full snapshot to delta storage (clears the journal). `keepLast` first compacts
   *  the log to a sliding window of that many events. */
  checkpoint(opts?: { keepLast?: number }): Promise<void>;
}

function buildDeps(opts: ArborOpts): TreeDeps {
  const base = opts.decompose ?? sizeBasedDecision(200);
  return {
    idGen: opts.idGen ?? new UuidIdGen(),
    clock: opts.clock ?? new SystemClock(),
    decision: opts.registry ? typeAwareDecision(base, opts.registry) : base,
  };
}

function assemble(
  opts: ArborOpts,
  tree: ArtifactTree,
  log: EventLog,
  vectors: VectorIndexPort,
  clock: Clock,
  hasCheckpoint: boolean,
): Arbor {
  const addressing = new Addressing(tree);
  const index = opts.embedding
    ? new SemanticIndex(tree, addressing, opts.embedding, vectors, opts.registry)
    : undefined;
  const mdeps: MutatorDeps = { clock };
  if (opts.registry) mdeps.validate = makeRegistryValidator(opts.registry);
  if (index) Object.assign(mdeps, index.hooks());
  const mutator = new Mutator(tree, addressing, log, mdeps);
  const replay = new Replay(tree, log);
  let highWater = log.length(); // delta journal position (everything before is persisted/checkpointed)
  let checkpointed = hasCheckpoint;

  async function doCheckpoint(keepLast?: number): Promise<void> {
    if (!opts.delta) throw new InvalidOpError("checkpoint(): no delta storage configured");
    if (keepLast !== undefined) log.compactTo(log.length() - keepLast);
    highWater = await persistCheckpoint(opts.delta, tree, log, vectors);
    checkpointed = true;
  }

  return {
    tree,
    addressing,
    log,
    mutator,
    replay,
    index,
    vectors,
    toolset: (binding) => makeToolset({ tree, addressing, log, mutator, index }, binding),
    save: async () => {
      if (!opts.storage) throw new InvalidOpError("save(): no storage configured");
      await opts.storage.save(await serializeArtifact(tree, log, vectors));
    },
    saveDelta: async () => {
      if (!opts.delta) throw new InvalidOpError("saveDelta(): no delta storage configured");
      if (!checkpointed) {
        // A journal with no checkpoint is unrestorable — snapshot instead.
        await doCheckpoint();
        return;
      }
      highWater = await persistDelta(opts.delta, log, highWater);
    },
    checkpoint: (o) => doCheckpoint(o?.keepLast),
  };
}

/** Build a fresh, fully wired artifact from `opts.initial` (default {}). */
export function createArbor(opts: ArborOpts = {}): Arbor {
  const deps = buildDeps(opts);
  const tree = ArtifactTree.fromJson(opts.initial ?? {}, deps);
  const log = new EventLog();
  const vectors = opts.vectors ?? new MemoryVectorIndex();
  const arbor = assemble(opts, tree, log, vectors, deps.clock, false);
  // Index the initial content: fromJson fires no hooks, so without this the
  // initial JSON would be unsearchable until first mutated.
  if (arbor.index) {
    for (const node of tree.allNodes()) arbor.index.onChange(node);
  }
  return arbor;
}

/**
 * Restore a fully wired artifact from persistence: prefers `delta` (checkpoint +
 * forward-replayed journal), falls back to `storage`, returns null when neither has
 * data. Owns the restore invariants: a fresh (or caller-provided) vector index is
 * upserted from the snapshot, the SemanticIndex is re-created (it re-seeds its stale
 * queue from node meta), and the idGen is guarded against collisions with restored
 * node ids. Use the SAME `decompose`/`registry` as the original run — journal-touched
 * nodes are re-decomposed on delta restore.
 */
export async function restoreArbor(opts: ArborOpts): Promise<Arbor | null> {
  const deps = buildDeps(opts);
  const vectors = opts.vectors ?? new MemoryVectorIndex();
  if (opts.delta) {
    const restored = await restoreFromDelta(opts.delta, deps, vectors); // guards its idGen internally
    if (restored) return assemble(opts, restored.tree, restored.log, vectors, deps.clock, true);
  }
  if (opts.storage) {
    const stored = await opts.storage.load();
    if (stored) {
      // restoreArtifact guards deps.idGen against collisions with restored node ids.
      const { tree, log } = await restoreArtifact(stored, deps, vectors);
      return assemble(opts, tree, log, vectors, deps.clock, false);
    }
  }
  return null;
}
