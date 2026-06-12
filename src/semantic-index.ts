import type { ArbNode, NodeId, Json } from "./types";
import type { ArtifactTree } from "./artifact-tree";
import type { Addressing } from "./addressing";
import type { TypeRegistry } from "./type-registry";
import type { EmbeddingPort } from "./embedding-port";
import type { VectorIndexPort } from "./vector-index-port";
import { toEmbeddingText, textHash } from "./embedding-text";

export interface SearchOpts {
  k?: number;
  under?: string;
  type?: string;
  tag?: string;
  freshness?: "best-effort" | "wait";
}

export interface SearchHit {
  id: NodeId;
  path: string;
  type?: string;
  score: number;
  snippet: string;
}

export interface SearchResult {
  results: SearchHit[];
  staleCount: number;
}

/**
 * Owns the per-node semantic index: a stale queue fed by mutation hooks, an async
 * batched reindexer, and (Task 6) search. Embedding is never in the mutation path —
 * mutations only mark stale; reindex does the async embedding work.
 */
export class SemanticIndex {
  private readonly stale = new Set<NodeId>();

  constructor(
    private readonly tree: ArtifactTree,
    private readonly addressing: Addressing,
    private readonly embedding: EmbeddingPort,
    private readonly vectors: VectorIndexPort,
    private readonly registry?: TypeRegistry,
  ) {
    // Recover the stale queue after a restore: `stale` itself is not persisted,
    // but each node's `meta.embedding.state` is. A fresh tree has only "none"
    // states, so this is a no-op there.
    for (const node of tree.allNodes()) {
      if (node.meta.embedding.state === "stale") this.stale.add(node.id);
    }
  }

  /** Mutation hook: a node's content changed (set/insert). Marks it stale if its embedding-text changed. */
  onChange(node: ArbNode): void {
    // If this node's parent has a registered type with a custom `embedText`, the
    // parent is the semantic unit and this node is just a decomposition artifact —
    // don't index it separately (it would produce false hits and outrank the parent).
    if (node.parentId !== null) {
      const parent = this.tree.get(node.parentId);
      if (parent?.type) {
        const parentTypeDef = this.registry?.get(parent.type);
        if (parentTypeDef?.embedText) {
          node.meta.embedding = { state: "none" };
          this.vectors.remove(node.id);
          this.stale.delete(node.id);
          return;
        }
      }
    }
    const value = this.tree.toJson(node.id);
    const typeDef = node.type ? this.registry?.get(node.type) : undefined;
    const text = toEmbeddingText(node, value, typeDef);
    if (text === null) {
      node.meta.embedding = { state: "none" };
      this.vectors.remove(node.id);
      this.stale.delete(node.id);
      return;
    }
    const hash = textHash(text);
    if (node.meta.embedding.state === "fresh" && node.meta.embedding.textHash === hash) {
      return;
    }
    node.meta.embedding = { state: "stale", textHash: hash };
    this.stale.add(node.id);
  }

  /** Mutation hook: a node was removed. Drops it from the index and the stale queue. */
  onRemove(nodeId: NodeId): void {
    this.vectors.remove(nodeId);
    this.stale.delete(nodeId);
  }

  /** Convenience: the hooks to wire into `MutatorDeps`. */
  hooks(): { onChange: (node: ArbNode) => void; onRemove: (nodeId: NodeId) => void } {
    return {
      onChange: (node) => this.onChange(node),
      onRemove: (nodeId) => this.onRemove(nodeId),
    };
  }

  staleCount(): number {
    return this.stale.size;
  }

  /** Embed every stale node (one batch), upsert vectors, mark fresh, clear the processed ids. */
  async reindex(): Promise<void> {
    const ids = [...this.stale];
    if (ids.length === 0) return;
    const items: { id: NodeId; text: string; hash: string }[] = [];
    for (const id of ids) {
      const node = this.tree.get(id);
      if (!node) continue;
      const value = this.tree.toJson(id);
      const typeDef = node.type ? this.registry?.get(node.type) : undefined;
      const text = toEmbeddingText(node, value, typeDef);
      if (text === null) {
        node.meta.embedding = { state: "none" };
        this.vectors.remove(id);
        continue;
      }
      items.push({ id, text, hash: textHash(text) });
    }
    if (items.length > 0) {
      const embedded = await this.embedding.embed(items.map((it) => it.text));
      this.vectors.upsert(items.map((it, i) => ({ nodeId: it.id, vector: embedded[i] })));
      for (const it of items) {
        const node = this.tree.get(it.id)!;
        node.meta.embedding = { state: "fresh", textHash: it.hash };
      }
    }
    for (const id of ids) this.stale.delete(id);
  }

  private snippetOf(value: Json): string {
    const s = JSON.stringify(value);
    return s.length <= 80 ? s : s.slice(0, 80) + "…";
  }

  /**
   * Semantic search: embed the query, rank indexed nodes by cosine, post-filter by
   * under/type/tag, return top-k. `freshness: "wait"` flushes the reindexer first;
   * default `best-effort` searches what's indexed and reports `staleCount`.
   */
  async search(queryText: string, opts: SearchOpts = {}): Promise<SearchResult> {
    if (opts.freshness === "wait") await this.reindex();
    const k = opts.k ?? 8;
    const [queryVec] = await this.embedding.embed([queryText]);
    const ranked = this.vectors.search(queryVec, this.vectors.size());
    const results: SearchHit[] = [];
    for (const hit of ranked) {
      if (results.length >= k) break;
      const node = this.tree.get(hit.nodeId);
      if (!node) continue;
      const path = this.addressing.pathOf(node.id);
      if (opts.under !== undefined && path !== opts.under && !path.startsWith(opts.under + "/")) continue;
      if (opts.type !== undefined && node.type !== opts.type) continue;
      if (opts.tag !== undefined && !(node.tags?.includes(opts.tag) ?? false)) continue;
      results.push({
        id: node.id,
        path,
        type: node.type,
        score: hit.score,
        snippet: this.snippetOf(this.tree.toJson(node.id)),
      });
    }
    return { results, staleCount: this.staleCount() };
  }
}
