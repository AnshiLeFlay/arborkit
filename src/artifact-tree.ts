import type { ArbNode, Json, NodeId } from "./types";
import type { IdGen } from "./ids";
import type { Clock } from "./clock";
import { type DecomposeDecision, kindOf } from "./decompose";
import { InvalidOpError } from "./errors";

export interface TreeDeps {
  idGen: IdGen;
  clock: Clock;
  decision: DecomposeDecision;
}

export interface TreeSnapshot {
  nodes: Map<NodeId, ArbNode>;
  rootId: NodeId;
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

  private build(value: Json, parentId: NodeId | null, key: string | number | null, type?: string): NodeId {
    const opaque = this.deps.decision.isOpaque(value, type);
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
    if (type !== undefined) node.type = type;
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

  /** Replace the subtree value at `id` in place, keeping the node's id/key/parentId.
   *  `clearType` explicitly un-types the node (used by type-aware revert). */
  replaceValue(id: NodeId, value: Json, type?: string, clearType = false): void {
    const node = this.nodes.get(id);
    if (!node) throw new InvalidOpError(`Unknown node: ${id}`);
    this.deleteDescendants(id);
    const opaque = this.deps.decision.isOpaque(value, type);
    const kind = kindOf(value, opaque);
    node.kind = kind;
    node.content = kind === "leaf" ? value : null;
    node.childIds = [];
    if (clearType) node.type = undefined;
    else if (type !== undefined) node.type = type;
    if (kind === "object") {
      for (const [k, v] of Object.entries(value as Record<string, Json>)) {
        node.childIds.push(this.build(v, id, k));
      }
    } else if (kind === "array") {
      (value as Json[]).forEach((v, i) => {
        node.childIds.push(this.build(v, id, i));
      });
    }
  }

  /** Recursively remove all descendants of `id` from the node map (keeps `id` itself). */
  private deleteDescendants(id: NodeId): void {
    const node = this.nodes.get(id);
    if (!node) return;
    for (const cid of node.childIds) {
      this.deleteDescendants(cid);
      this.nodes.delete(cid);
    }
    node.childIds = [];
  }

  /** Deep, independent copy of the tree state for transaction rollback. */
  snapshot(): TreeSnapshot {
    const nodes = new Map<NodeId, ArbNode>();
    for (const [id, node] of this.nodes) {
      nodes.set(id, structuredClone(node));
    }
    return { nodes, rootId: this.rootId };
  }

  /** Replace the tree state with a previously taken snapshot. */
  restore(snap: TreeSnapshot): void {
    this.nodes.clear();
    for (const [id, node] of snap.nodes) {
      this.nodes.set(id, structuredClone(node));
    }
    this.rootId = snap.rootId;
  }

  /** Insert a decomposed `value` as a child of `parentId`. For objects `keyOrIndex` is the string key; for arrays it is the insert index. Returns the new child's id. */
  insertChild(parentId: NodeId, keyOrIndex: string | number, value: Json, type?: string): NodeId {
    const parent = this.nodes.get(parentId);
    if (!parent) throw new InvalidOpError(`Unknown node: ${parentId}`);
    if (parent.kind === "object") {
      if (typeof keyOrIndex !== "string") {
        throw new InvalidOpError("object insert requires a string key");
      }
      if (parent.childIds.some((cid) => this.nodes.get(cid)!.key === keyOrIndex)) {
        throw new InvalidOpError(`key already exists: ${keyOrIndex}`);
      }
      const cid = this.build(value, parentId, keyOrIndex, type);
      parent.childIds.push(cid);
      return cid;
    }
    if (parent.kind === "array") {
      if (typeof keyOrIndex !== "number") {
        throw new InvalidOpError("array insert requires a numeric index");
      }
      const at = Math.max(0, Math.min(keyOrIndex, parent.childIds.length));
      const cid = this.build(value, parentId, at, type);
      parent.childIds.splice(at, 0, cid);
      this.renumberArray(parentId);
      return cid;
    }
    throw new InvalidOpError("cannot insert into a leaf node");
  }

  /** Remove `childId` (and its subtree) from `parentId`. Renumbers array siblings. */
  removeChild(parentId: NodeId, childId: NodeId): void {
    const parent = this.nodes.get(parentId);
    if (!parent) throw new InvalidOpError(`Unknown node: ${parentId}`);
    const idx = parent.childIds.indexOf(childId);
    if (idx < 0) throw new InvalidOpError(`${childId} is not a child of ${parentId}`);
    this.deleteDescendants(childId);
    this.nodes.delete(childId);
    parent.childIds.splice(idx, 1);
    if (parent.kind === "array") this.renumberArray(parentId);
  }

  /** Move `id` under `newParentId` at `keyOrIndex`, preserving `id`. Renumbers affected arrays. */
  moveNode(id: NodeId, newParentId: NodeId, keyOrIndex: string | number): void {
    const node = this.nodes.get(id);
    if (!node) throw new InvalidOpError(`Unknown node: ${id}`);
    if (node.parentId === null) throw new InvalidOpError("cannot move the root");
    const newParent = this.nodes.get(newParentId);
    if (!newParent) throw new InvalidOpError(`Unknown node: ${newParentId}`);
    if (newParent.kind === "leaf") throw new InvalidOpError("cannot move into a leaf node");

    const oldParent = this.nodes.get(node.parentId)!;
    const oldIdx = oldParent.childIds.indexOf(id);
    oldParent.childIds.splice(oldIdx, 1);
    if (oldParent.kind === "array") this.renumberArray(oldParent.id);

    if (newParent.kind === "object") {
      if (typeof keyOrIndex !== "string") throw new InvalidOpError("object move requires a string key");
      node.parentId = newParentId;
      node.key = keyOrIndex;
      newParent.childIds.push(id);
    } else {
      const at = typeof keyOrIndex === "number" ? Math.max(0, Math.min(keyOrIndex, newParent.childIds.length)) : newParent.childIds.length;
      node.parentId = newParentId;
      newParent.childIds.splice(at, 0, id);
      this.renumberArray(newParentId);
    }
  }

  /** Set each array child's `key` to its current position. */
  private renumberArray(parentId: NodeId): void {
    const parent = this.nodes.get(parentId);
    if (!parent) return;
    parent.childIds.forEach((cid, i) => {
      this.nodes.get(cid)!.key = i;
    });
  }

  /** All nodes in the tree (for serialization). */
  allNodes(): ArbNode[] {
    return [...this.nodes.values()];
  }

  /** Rebuild a tree from previously serialized nodes, preserving their ids. */
  static fromStored(nodes: ArbNode[], rootId: NodeId, deps: TreeDeps): ArtifactTree {
    const tree = new ArtifactTree(deps);
    for (const node of nodes) tree.nodes.set(node.id, node);
    tree.rootId = rootId;
    return tree;
  }

  /** All transitive descendant ids of `id` (depth-first), excluding `id` itself. */
  descendantIds(id: NodeId): NodeId[] {
    const out: NodeId[] = [];
    const node = this.nodes.get(id);
    if (!node) return out;
    for (const cid of node.childIds) {
      out.push(cid);
      out.push(...this.descendantIds(cid));
    }
    return out;
  }
}
