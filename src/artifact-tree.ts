import type { ArbNode, Json, NodeId } from "./types";
import type { IdGen } from "./ids";
import type { Clock } from "./clock";
import { type DecomposeDecision, kindOf } from "./decompose";

export interface TreeDeps {
  idGen: IdGen;
  clock: Clock;
  decision: DecomposeDecision;
}

export class ArtifactTree {
  private readonly nodes = new Map<NodeId, ArbNode>();
  private rootId!: NodeId;

  private constructor(private readonly deps: TreeDeps) {}

  static fromJson(json: Json, deps: TreeDeps): ArtifactTree {
    const tree = new ArtifactTree(deps);
    tree.rootId = tree.build(json, null, null);
    return tree;
  }

  private build(value: Json, parentId: NodeId | null, key: string | number | null): NodeId {
    const opaque = this.deps.decision.isOpaque(value);
    const kind = kindOf(value, opaque);
    const id = this.deps.idGen.next();
    const node: ArbNode = {
      id,
      parentId,
      key,
      kind,
      content: kind === "leaf" ? value : null,
      childIds: [],
      meta: { version: 0, updatedAt: this.deps.clock.now(), embedding: { state: "none" } },
    };
    this.nodes.set(id, node);

    if (kind === "object") {
      for (const [k, v] of Object.entries(value as Record<string, Json>)) {
        node.childIds.push(this.build(v, id, k));
      }
    } else if (kind === "array") {
      (value as Json[]).forEach((v, i) => {
        node.childIds.push(this.build(v, id, i));
      });
    }
    return id;
  }

  get(id: NodeId): ArbNode | undefined {
    return this.nodes.get(id);
  }

  root(): ArbNode {
    return this.nodes.get(this.rootId)!;
  }

  rootIdValue(): NodeId {
    return this.rootId;
  }

  children(id: NodeId): ArbNode[] {
    const n = this.nodes.get(id);
    if (!n) return [];
    return n.childIds.map((cid) => this.nodes.get(cid)!);
  }

  has(id: NodeId): boolean {
    return this.nodes.has(id);
  }

  size(): number {
    return this.nodes.size;
  }

  /** Reconstruct the JSON value rooted at `id` (defaults to the tree root). */
  toJson(id: NodeId = this.rootId): Json {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`Unknown node: ${id}`);
    if (n.kind === "leaf") return n.content;
    if (n.kind === "array") return n.childIds.map((cid) => this.toJson(cid));
    const obj: Record<string, Json> = {};
    for (const cid of n.childIds) {
      const c = this.nodes.get(cid)!;
      obj[String(c.key)] = this.toJson(cid);
    }
    return obj;
  }
}
