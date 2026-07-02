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
  private readonly pendingRemoval = new Set<NodeId>();

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

  /**
   * A node is a suppressed decomposition shard iff some ANCESTOR has a typed
   * embedText AND the node does not itself declare a typed embedText.
   * (O(depth) walk per call — fine at v1 artifact sizes.)
   */
  private isSuppressedShard(node: ArbNode): boolean {
    const ownTypeDef = node.type ? this.registry?.get(node.type) : undefined;
    if (ownTypeDef?.embedText) return false; // node is its own semantic unit
    let pid = node.parentId;
    while (pid !== null) {
      const anc = this.tree.get(pid);
      const ancDef = anc?.type ? this.registry?.get(anc.type) : undefined;
      if (ancDef?.embedText) return true;
      pid = anc?.parentId ?? null;
    }
    return false;
  }

  /** Mutation hook: a node's content changed (set/insert). Marks it stale if its embedding-text changed. */
  onChange(node: ArbNode): void {
    if (this.isSuppressedShard(node)) {
      node.meta.embedding = { state: "none" };
      this.pendingRemoval.add(node.id);
      this.stale.delete(node.id);
      return;
    }
    const value = this.tree.toJson(node.id);
    const typeDef = node.type ? this.registry?.get(node.type) : undefined;
    const text = toEmbeddingText(node, value, typeDef);
    if (text === null) {
      node.meta.embedding = { state: "none" };
      this.pendingRemoval.add(node.id);
      this.stale.delete(node.id);
      return;
    }
    const hash = textHash(text);
    if (node.meta.embedding.state === "fresh" && node.meta.embedding.textHash === hash) {
      return;
    }
    node.meta.embedding = { state: "stale", textHash: hash };
    this.pendingRemoval.delete(node.id);
    this.stale.add(node.id);
  }

  /** Mutation hook: a node was removed. Drops it from the index and the stale queue. */
  onRemove(nodeId: NodeId): void {
    this.pendingRemoval.add(nodeId);
    this.stale.delete(nodeId);
  }

  /**
   * Snapshot of both queues for transaction rollback.
   *
   * The sync hooks (`onChange`, `onRemove`) only move ids between the `stale`
   * queue and the `pendingRemoval` queue; all actual vector mutations happen in
   * the async `reindex()`. This snapshot covers both queues so that a rollback
   * fully restores the observable state of the index without touching vectors.
   */
  txSnapshot(): unknown {
    return {
      stale: new Set(this.stale),
      pendingRemoval: new Set(this.pendingRemoval),
    };
  }

  /** Restore both queues captured by `txSnapshot`. */
  txRestore(snapshot: unknown): void {
    const snap = snapshot as { stale: Set<NodeId>; pendingRemoval: Set<NodeId> };
    this.stale.clear();
    for (const id of snap.stale) this.stale.add(id);
    this.pendingRemoval.clear();
    for (const id of snap.pendingRemoval) this.pendingRemoval.add(id);
  }

  /** Convenience: the hooks to wire into `MutatorDeps`. */
  hooks(): {
    onChange: (node: ArbNode) => void;
    onRemove: (nodeId: NodeId) => void;
    onTxSnapshot: () => unknown;
    onTxRestore: (snapshot: unknown) => void;
  } {
    return {
      onChange: (node) => this.onChange(node),
      onRemove: (nodeId) => this.onRemove(nodeId),
      onTxSnapshot: () => this.txSnapshot(),
      onTxRestore: (snapshot) => this.txRestore(snapshot),
    };
  }

  staleCount(): number {
    return this.stale.size;
  }

  /** Embed every stale node (one batch), upsert vectors, mark fresh, clear the processed ids.
   *  Interleave-safe: mutations landing during the embed await are respected — a node
   *  removed mid-flight is dropped (never resurrected), and a node whose text changed
   *  stays queued for the next pass instead of being marked fresh for the old text. */
  async reindex(): Promise<void> {
    // First: drain deferred removals (HOLE 2 fix — removals queued by sync hooks).
    for (const id of this.pendingRemoval) this.vectors.remove(id);
    this.pendingRemoval.clear();

    const ids = [...this.stale];
    if (ids.length === 0) return;
    const completed = new Set<NodeId>();
    const items: { id: NodeId; text: string; hash: string }[] = [];
    for (const id of ids) {
      const node = this.tree.get(id);
      if (!node) {
        completed.add(id);
        continue;
      }
      // HOLE 1 fix: guard-aware reindex — suppress shards that belong to a typed
      // ancestor's embedding unit.
      if (this.isSuppressedShard(node)) {
        node.meta.embedding = { state: "none" };
        this.vectors.remove(id);
        completed.add(id);
        continue;
      }
      const value = this.tree.toJson(id);
      const typeDef = node.type ? this.registry?.get(node.type) : undefined;
      const text = toEmbeddingText(node, value, typeDef);
      if (text === null) {
        node.meta.embedding = { state: "none" };
        this.vectors.remove(id);
        completed.add(id);
        continue;
      }
      items.push({ id, text, hash: textHash(text) });
    }
    if (items.length > 0) {
      const embedded = await this.embedding.embed(items.map((it) => it.text));
      // Mutations may have landed during the await — re-validate every item
      // against the live tree before trusting the embedded batch.
      const upserts: { nodeId: NodeId; vector: number[] }[] = [];
      for (const [i, it] of items.entries()) {
        const node = this.tree.get(it.id);
        if (!node) {
          this.vectors.remove(it.id); // removed mid-flight — do not resurrect
          completed.add(it.id);
          continue;
        }
        // Positive trust check: mark fresh ONLY if the node still awaits exactly the
        // text we embedded. "none" (text became null / became a suppressed shard
        // mid-flight) means its removal is already queued — complete without
        // upserting; any other divergence (new hash) stays queued for the next pass.
        if (node.meta.embedding.state !== "stale" || node.meta.embedding.textHash !== it.hash) {
          if (node.meta.embedding.state === "none") completed.add(it.id);
          continue;
        }
        upserts.push({ nodeId: it.id, vector: embedded[i] });
        node.meta.embedding = { state: "fresh", textHash: it.hash };
        completed.add(it.id);
      }
      if (upserts.length > 0) this.vectors.upsert(upserts);
    }
    for (const id of ids) {
      if (completed.has(id)) this.stale.delete(id);
    }
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
      // Skip logically-removed entries that haven't been physically flushed yet.
      if (this.pendingRemoval.has(hit.nodeId)) continue;
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
