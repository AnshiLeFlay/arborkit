import type { ArbNode, NodeId } from "./types";
import { ArtifactTree, type TreeDeps } from "./artifact-tree";
import { EventLog, type MutationEvent } from "./event-log";
import type { VectorIndexPort, VectorIndexEntry } from "./vector-index-port";

/** A JSON-serializable snapshot of an entire artifact: tree + event-log + vectors.
 *  v2 adds `baseSeq` (the event-log compaction floor); v1 files restore with floor 0. */
export interface StoredArtifact {
  version: 1 | 2;
  rootId: NodeId;
  nodes: ArbNode[];
  events: MutationEvent[];
  /** Absolute seq of the oldest retained event (compaction floor). Absent in v1 → 0. */
  baseSeq?: number;
  vectors: VectorIndexEntry[];
}

/** Persists/loads a StoredArtifact. Adapters: MemoryStorage, FileStorage (and DB-backed later). */
export interface StoragePort {
  save(artifact: StoredArtifact): Promise<void>;
  load(): Promise<StoredArtifact | null>;
}

/** Dump the live components into a StoredArtifact (v2). */
export function serializeArtifact(tree: ArtifactTree, log: EventLog, vectors: VectorIndexPort): StoredArtifact {
  return {
    version: 2,
    rootId: tree.rootIdValue(),
    nodes: tree.allNodes(),
    events: [...log.entries()],
    baseSeq: log.baseSeqValue(),
    vectors: vectors.entries(),
  };
}

/** Rebuild a fresh tree + log from a StoredArtifact, and upsert its vectors into `vectors`. */
export function restoreArtifact(
  stored: StoredArtifact,
  deps: TreeDeps,
  vectors: VectorIndexPort,
): { tree: ArtifactTree; log: EventLog } {
  const tree = ArtifactTree.fromStored(stored.nodes, stored.rootId, deps);
  const log = EventLog.fromStored(stored.events, stored.baseSeq ?? 0);
  vectors.upsert(stored.vectors);
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
