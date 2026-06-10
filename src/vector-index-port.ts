import type { NodeId } from "./types";

export interface VectorIndexEntry {
  nodeId: NodeId;
  vector: number[];
}

export interface VectorHit {
  nodeId: NodeId;
  score: number;
}

/** Stores per-node vectors and ranks by similarity. Brute-force impl below; pgvector/sqlite-vec later. */
export interface VectorIndexPort {
  upsert(entries: VectorIndexEntry[]): void;
  remove(nodeId: NodeId): void;
  search(query: number[], k: number): VectorHit[];
  has(nodeId: NodeId): boolean;
  size(): number;
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

  upsert(entries: VectorIndexEntry[]): void {
    for (const e of entries) this.vectors.set(e.nodeId, e.vector);
  }

  remove(nodeId: NodeId): void {
    this.vectors.delete(nodeId);
  }

  has(nodeId: NodeId): boolean {
    return this.vectors.has(nodeId);
  }

  size(): number {
    return this.vectors.size;
  }

  search(query: number[], k: number): VectorHit[] {
    const hits: VectorHit[] = [];
    for (const [nodeId, vector] of this.vectors) {
      hits.push({ nodeId, score: cosine(query, vector) });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }
}
