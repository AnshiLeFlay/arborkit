import type { NodeId } from "./types";

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

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** In-memory brute-force cosine index. Correct and simple at current scale. */
export class MemoryVectorIndex implements VectorIndexPort {
  private readonly vectors = new Map<NodeId, number[]>();

  async upsert(entries: VectorIndexEntry[]): Promise<void> {
    for (const e of entries) this.vectors.set(e.nodeId, e.vector);
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
    const hits: VectorHit[] = [];
    for (const [nodeId, vector] of this.vectors) {
      hits.push({ nodeId, score: cosine(query, vector) });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }

  async entries(): Promise<VectorIndexEntry[]> {
    return [...this.vectors].map(([nodeId, vector]) => ({ nodeId, vector }));
  }
}
