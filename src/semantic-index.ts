import type { ArbNode, NodeId } from "./types";
import type { ArtifactTree } from "./artifact-tree";
import type { Addressing } from "./addressing";
import type { TypeRegistry } from "./type-registry";
import type { EmbeddingPort } from "./embedding-port";
import type { VectorIndexPort } from "./vector-index-port";
import { toEmbeddingText, textHash } from "./embedding-text";

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
  ) {}

  /** Mutation hook: a node's content changed (set/insert). Marks it stale if its embedding-text changed. */
  onChange(node: ArbNode): void {
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
}
