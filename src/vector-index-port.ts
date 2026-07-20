import type { NodeId } from "./types";
import { dot, normalize } from "./vec-math";

export interface VectorIndexEntry {
  nodeId: NodeId;
  vector: number[];
  /** Search metadata used by DB-backed indexes. Optional for backwards compatibility. */
  metadata?: VectorIndexMetadata;
}

export interface VectorIndexMetadata {
  path?: string;
  /** The node path plus every ancestor JSON Pointer, including the root pointer. */
  scopePaths?: string[];
  type?: string;
  tags?: string[];
  textHash?: string;
}

export interface VectorSearchFilter {
  under?: string;
  type?: string;
  tag?: string;
}

export interface VectorIndexCapabilities {
  /** Durable indexes survive an Arbor process restart. */
  persistent: boolean;
  /** Filters applied by the backend before top-k ranking. */
  filters: Array<keyof VectorSearchFilter>;
  /** Whether `metadata()` can reconcile persisted vectors by text hash. */
  metadata: boolean;
}

export interface VectorHit {
  nodeId: NodeId;
  score: number;
}

/** Stores per-node vectors and ranks by similarity. Async so DB-backed adapters
 *  (pgvector, sqlite-vec) can implement it; the in-memory default is sync inside. */
export interface VectorIndexPort {
  readonly capabilities?: VectorIndexCapabilities;
  upsert(entries: VectorIndexEntry[]): Promise<void>;
  remove(nodeId: NodeId): Promise<void>;
  search(query: number[], k: number, filter?: VectorSearchFilter): Promise<VectorHit[]>;
  has(nodeId: NodeId): Promise<boolean>;
  size(): Promise<number>;
  entries(): Promise<VectorIndexEntry[]>;
  /** Optional batched metadata lookup. Missing ids are omitted. */
  metadata?(nodeIds: readonly NodeId[]): Promise<Map<NodeId, VectorIndexMetadata>>;
}

/** In-memory brute-force index. Vectors are stored as Float32Arrays (raw for
 *  `entries()`, unit-normalized for search) so `search` is a plain dot product
 *  — the cosine of two normalized vectors. Correct and simple at current scale. */
export class MemoryVectorIndex implements VectorIndexPort {
  readonly capabilities: VectorIndexCapabilities = { persistent: false, filters: [], metadata: true };
  private readonly vectors = new Map<NodeId, {
    raw: Float32Array;
    unit: Float32Array;
    metadata?: VectorIndexMetadata;
  }>();

  async upsert(entries: VectorIndexEntry[]): Promise<void> {
    for (const e of entries) {
      this.vectors.set(e.nodeId, {
        raw: Float32Array.from(e.vector),
        unit: normalize(e.vector),
        metadata: e.metadata ? structuredClone(e.metadata) : undefined,
      });
    }
  }

  async remove(nodeId: NodeId): Promise<void> {
    this.vectors.delete(nodeId);
  }

  async has(nodeId: NodeId): Promise<boolean> {
    return this.vectors.has(nodeId);
  }

  async size(): Promise<number> {
    return this.vectors.size;
  }

  async search(query: number[], k: number): Promise<VectorHit[]> {
    const q = normalize(query);
    const hits: VectorHit[] = [];
    for (const [nodeId, { unit }] of this.vectors) {
      hits.push({ nodeId, score: dot(q, unit) });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }

  async entries(): Promise<VectorIndexEntry[]> {
    return [...this.vectors].map(([nodeId, { raw, metadata }]) => ({
      nodeId,
      vector: Array.from(raw),
      ...(metadata ? { metadata: structuredClone(metadata) } : {}),
    }));
  }

  async metadata(nodeIds: readonly NodeId[]): Promise<Map<NodeId, VectorIndexMetadata>> {
    const result = new Map<NodeId, VectorIndexMetadata>();
    for (const id of nodeIds) {
      const metadata = this.vectors.get(id)?.metadata;
      if (metadata) result.set(id, structuredClone(metadata));
    }
    return result;
  }
}
