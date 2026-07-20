import type { ArbNode, NodeId, Json } from "./types";
import type { ArtifactTree } from "./artifact-tree";
import type { Addressing } from "./addressing";
import type { TypeRegistry } from "./type-registry";
import type { EmbeddingPort } from "./embedding-port";
import type { VectorIndexEntry, VectorIndexPort, VectorSearchFilter } from "./vector-index-port";
import { toEmbeddingText, textHash } from "./embedding-text";
import { isWithin } from "./jsonpointer";

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

  /** The nearest ancestor whose type declares embedText — the semantic unit that
   *  owns this shard — or undefined. (O(depth) walk per call — fine at v1 sizes.) */
  private embedTextAncestor(node: ArbNode): ArbNode | undefined {
    let pid = node.parentId;
    while (pid !== null) {
      const anc = this.tree.get(pid);
      const ancDef = anc?.type ? this.registry?.get(anc.type) : undefined;
      if (ancDef?.embedText) return anc;
      pid = anc?.parentId ?? null;
    }
    return undefined;
  }

  /**
   * A node is a suppressed decomposition shard iff some ANCESTOR has a typed
   * embedText AND the node does not itself declare a typed embedText.
   */
  private isSuppressedShard(node: ArbNode): boolean {
    const ownTypeDef = node.type ? this.registry?.get(node.type) : undefined;
    if (ownTypeDef?.embedText) return false; // node is its own semantic unit
    return this.embedTextAncestor(node) !== undefined;
  }

  /** Mutation hook: a node's content changed (set/insert). Marks it stale if its embedding-text changed. */
  onChange(node: ArbNode): void {
    if (this.isSuppressedShard(node)) {
      node.meta.embedding = { state: "none" };
      this.pendingRemoval.add(node.id);
      this.stale.delete(node.id);
    } else {
      this.refresh(node);
    }
    // embedText units can NEST: EVERY embedText-typed ancestor's embed text may
    // cover this subtree — not just the nearest owning unit — so re-hash them ALL
    // up to the root. `refresh`'s hash compare settles unaffected units (e.g. an
    // outer unit whose text ignores this subtree) without queueing a re-embed.
    let pid = node.parentId;
    while (pid !== null) {
      const anc = this.tree.get(pid);
      if (!anc) break;
      const ancDef = anc.type ? this.registry?.get(anc.type) : undefined;
      if (ancDef?.embedText) this.refresh(anc);
      pid = anc.parentId;
    }
  }

  /** Recompute `node`'s own embed text and reconcile its state: unembeddable →
   *  "none" (+queued removal), unchanged fresh hash → no-op, otherwise "stale".
   *  Callers guarantee `node` is not a suppressed shard (a node with its own
   *  typed embedText never is). */
  private refresh(node: ArbNode): void {
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

  /** Mark every currently-fresh semantic unit stale. Used when restoring into an
   *  ephemeral or intentionally rebuilt vector index. */
  invalidateFresh(): void {
    for (const node of this.tree.allNodes()) {
      if (node.meta.embedding.state === "fresh") {
        node.meta.embedding = { state: "stale", textHash: node.meta.embedding.textHash };
        this.stale.add(node.id);
      }
    }
  }

  /** Reconcile persisted node metadata with a durable vector backend. A missing
   *  vector or mismatched text hash is safe: the node is queued for reindex. */
  async reconcilePersistent(): Promise<void> {
    if (!this.vectors.capabilities?.persistent || !this.vectors.metadata) {
      this.invalidateFresh();
      return;
    }
    const fresh = this.tree.allNodes().filter((node) => node.meta.embedding.state === "fresh");
    const metadata = await this.vectors.metadata(fresh.map((node) => node.id));
    for (const node of fresh) {
      if (metadata.get(node.id)?.textHash !== node.meta.embedding.textHash) {
        node.meta.embedding = { state: "stale", textHash: node.meta.embedding.textHash };
        this.stale.add(node.id);
      }
    }
  }

  /** Embed every stale node (one batch), upsert vectors, mark fresh, clear the processed ids.
   *  Interleave-safe: mutations landing during the embed await are respected — a node
   *  removed mid-flight is dropped (never resurrected), and a node whose text changed
   *  stays queued for the next pass instead of being marked fresh for the old text. */
  async reindex(): Promise<void> {
    // First: drain deferred removals (HOLE 2 fix — removals queued by sync hooks).
    for (const id of this.pendingRemoval) await this.vectors.remove(id);
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
        await this.vectors.remove(id);
        completed.add(id);
        continue;
      }
      const value = this.tree.toJson(id);
      const typeDef = node.type ? this.registry?.get(node.type) : undefined;
      const text = toEmbeddingText(node, value, typeDef);
      if (text === null) {
        node.meta.embedding = { state: "none" };
        await this.vectors.remove(id);
        completed.add(id);
        continue;
      }
      items.push({ id, text, hash: textHash(text) });
    }
    if (items.length > 0) {
      const embedded = await this.embedding.embed(items.map((it) => it.text));
      // Mutations may have landed during the await — re-validate every item
      // against the live tree before trusting the embedded batch.
      const upserts: VectorIndexEntry[] = [];
      const prepared = new Set<NodeId>();
      for (const [i, it] of items.entries()) {
        const node = this.tree.get(it.id);
        if (!node) {
          await this.vectors.remove(it.id); // removed mid-flight — do not resurrect
          completed.add(it.id);
          continue;
        }
        // Positive trust check: mark fresh ONLY if the node still awaits exactly the
        // text we embedded. "none" (text became null / became a suppressed shard
        // mid-flight) means its removal is already queued — complete without
        // upserting; any other divergence (new hash) stays queued for the next pass.
        // A stale node with NO textHash (a delta-restored node — restoreFromDelta
        // marks {state:"stale"} without a hash) cannot have been touched during the
        // await: any mid-flight change writes a concrete hash ("stale"), "none", or
        // removes the node. So an undefined hash means our pre-await snapshot is
        // current — trust the batch.
        const cur = node.meta.embedding;
        if (cur.state !== "stale" || (cur.textHash !== undefined && cur.textHash !== it.hash)) {
          if (node.meta.embedding.state === "none") completed.add(it.id);
          continue;
        }
        const path = this.addressing.pathOf(it.id);
        const scopePaths = [""];
        if (path !== "") {
          const segments = path.slice(1).split("/");
          let scope = "";
          for (const segment of segments) {
            scope += `/${segment}`;
            scopePaths.push(scope);
          }
        }
        upserts.push({
          nodeId: it.id,
          vector: embedded[i],
          metadata: {
            path,
            scopePaths,
            ...(node.type !== undefined ? { type: node.type } : {}),
            ...(node.tags !== undefined ? { tags: [...node.tags] } : {}),
            textHash: it.hash,
          },
        });
        prepared.add(it.id);
      }
      if (upserts.length > 0) {
        await this.vectors.upsert(upserts);
        // Only trust the completed remote write if the node still awaits the
        // exact text that was embedded. A concurrent mutation remains stale.
        for (const item of items) {
          if (!prepared.has(item.id)) continue;
          const node = this.tree.get(item.id);
          if (!node) {
            await this.vectors.remove(item.id);
            completed.add(item.id);
            continue;
          }
          const current = node.meta.embedding;
          if (current.state === "stale" &&
              (current.textHash === undefined || current.textHash === item.hash)) {
            node.meta.embedding = { state: "fresh", textHash: item.hash };
            completed.add(item.id);
          }
        }
      }
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
    const filter: VectorSearchFilter = {};
    if (opts.under !== undefined) filter.under = opts.under;
    if (opts.type !== undefined) filter.type = opts.type;
    if (opts.tag !== undefined) filter.tag = opts.tag;
    const requestedFilters = Object.keys(filter) as Array<keyof VectorSearchFilter>;
    const nativeFilters = this.vectors.capabilities?.filters ?? [];
    const canFilterNatively = requestedFilters.every((name) => nativeFilters.includes(name));
    const ranked = await this.vectors.search(
      queryVec,
      canFilterNatively ? k : await this.vectors.size(),
      canFilterNatively ? filter : undefined,
    );
    const results: SearchHit[] = [];
    for (const hit of ranked) {
      if (results.length >= k) break;
      // Skip logically-removed entries that haven't been physically flushed yet.
      if (this.pendingRemoval.has(hit.nodeId)) continue;
      const node = this.tree.get(hit.nodeId);
      if (!node) continue;
      const path = this.addressing.pathOf(node.id);
      if (opts.under !== undefined && !isWithin(path, opts.under)) continue;
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
