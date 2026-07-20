import type { ArbNode, NodeId } from "./types";
import { ArtifactTree, type TreeDeps } from "./artifact-tree";
import { EventLog, type MutationEvent } from "./event-log";
import { guardIdGen } from "./ids";
import type { VectorIndexPort, VectorIndexEntry } from "./vector-index-port";
import type { ArtifactConfigIdentity } from "./durable";

/** A JSON-serializable snapshot of an entire artifact: tree + event-log + vectors.
 *  v2 adds `baseSeq` (the event-log compaction floor); v1 files restore with floor 0. */
export interface StoredArtifact {
  version: 1 | 2 | 3;
  rootId: NodeId;
  nodes: ArbNode[];
  events: MutationEvent[];
  /** Absolute seq of the oldest retained event (compaction floor). Absent in v1 → 0. */
  baseSeq?: number;
  /** Optional in v3: durable vector indexes are derivative and reconciled separately. */
  vectors?: VectorIndexEntry[];
  /** Human-readable runtime identity used by durable restore validation. */
  config?: ArtifactConfigIdentity;
}

export interface SerializeArtifactOptions {
  /** Legacy snapshots include vectors by default; durable checkpoints disable this. */
  includeVectors?: boolean;
  config?: ArtifactConfigIdentity;
}

/** Persists/loads a StoredArtifact. Adapters: MemoryStorage, FileStorage (and DB-backed later). */
export interface StoragePort {
  save(artifact: StoredArtifact): Promise<void>;
  load(): Promise<StoredArtifact | null>;
}

/** Dump the live components into a StoredArtifact (v2). */
export async function serializeArtifact(
  tree: ArtifactTree,
  log: EventLog,
  vectors: VectorIndexPort,
  options: SerializeArtifactOptions = {},
): Promise<StoredArtifact> {
  const stored: StoredArtifact = {
    version: 3,
    rootId: tree.rootIdValue(),
    nodes: tree.allNodes(),
    events: [...log.entries()],
    baseSeq: log.baseSeqValue(),
  };
  if (options.includeVectors !== false) stored.vectors = await vectors.entries();
  if (options.config !== undefined) stored.config = structuredClone(options.config);
  return stored;
}

/** Rebuild a fresh tree + log from a StoredArtifact, and upsert its vectors into `vectors`.
 *  `deps.idGen` is wrapped with `guardIdGen` seeded from the restored node ids: `fromStored`
 *  preserves stored ids, so a deterministic generator restarted in a new process would
 *  otherwise re-mint a live id on the next mutation and silently corrupt the tree. The
 *  guard stays on the returned tree's deps, so ALL post-restore mutations are safe. */
export async function restoreArtifact(
  stored: StoredArtifact,
  deps: TreeDeps,
  vectors: VectorIndexPort,
): Promise<{ tree: ArtifactTree; log: EventLog }> {
  const guardedDeps: TreeDeps = {
    ...deps,
    idGen: guardIdGen(deps.idGen, new Set(stored.nodes.map((n) => n.id))),
  };
  const tree = ArtifactTree.fromStored(stored.nodes, stored.rootId, guardedDeps);
  const log = EventLog.fromStored(stored.events, stored.baseSeq ?? 0);
  await vectors.upsert(stored.vectors ?? []);
  return { tree, log };
}

/** In-memory StoragePort: holds a deep-cloned bundle. */
export class MemoryStorage implements StoragePort {
  private stored: StoredArtifact | null = null;

  async save(artifact: StoredArtifact): Promise<void> {
    this.stored = structuredClone(artifact);
  }

  async load(): Promise<StoredArtifact | null> {
    return this.stored ? structuredClone(this.stored) : null;
  }
}
