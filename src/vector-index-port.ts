import type { NodeId } from "./types";
import { dot, normalize } from "./vec-math";

export interface VectorIndexEntry {
  nodeId: NodeId;
  vector: number[];
}

export interface VectorHit {
  nodeId: NodeId;
  score: number;
}

/** Stores per-node vectors and ranks by similarity. Async so DB-backed adapters
 *  (pgvector, sqlite-vec) can implement it; the in-memory default is sync inside. */
export interface VectorIndexPort {
  upsert(entries: VectorIndexEntry[]): Promise<void>;
  remove(nodeId: NodeId): Promise<void>;
  search(query: number[], k: number): Promise<VectorHit[]>;
  has(nodeId: NodeId): Promise<boolean>;
  size(): Promise<number>;
  entries(): Promise<VectorIndexEntry[]>;
}

/** Unit-normalize into a Float32Array; zero-norm vectors stay all-zeros
 *  (their dot with anything is 0 — matches cosine's zero-magnitude behavior). */
/** In-memory brute-force index. Vectors are stored as Float32Arrays (raw for
 *  `entries()`, unit-normalized for search) so `search` is a plain dot product
 *  — the cosine of two normalized vectors. Correct and simple at current scale. */
export class MemoryVectorIndex implements VectorIndexPort {
  private readonly vectors = new Map<NodeId, { raw: Float32Array; unit: Float32Array }>();

  async upsert(entries: VectorIndexEntry[]): Promise<void> {
    for (const e of entries) {
      this.vectors.set(e.nodeId, { raw: Float32Array.from(e.vector), unit: normalize(e.vector) });
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
    return [...this.vectors].map(([nodeId, { raw }]) => ({ nodeId, vector: Array.from(raw) }));
  }
}
