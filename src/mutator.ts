import type { ArbNode, Json, NodeId } from "./types";
import type { Clock } from "./clock";
import type { ArtifactTree } from "./artifact-tree";
import type { Addressing } from "./addressing";
import type { EventLog, OpKind } from "./event-log";
import { type Ref, NodeNotFoundError, ScopeViolationError, StaleVersionError, InvalidOpError } from "./errors";

/** Optional validation hook. Throws to reject a mutation. M3 plugs Zod in here. */
export type Validator = (input: { node: ArbNode | null; proposed: Json; type?: string; op: OpKind }) => void;

export interface MutatorDeps {
  clock: Clock;
  validate?: Validator;
}

export interface MutateOpts {
  owner?: string;
  /** JSON Pointer prefix; the target must be at or under it. */
  writeScope?: string;
  /** Optimistic concurrency: reject unless the target's current version equals this. */
  ifVersion?: number;
  /** Register/override the node's type (drives validation and the decompose override). */
  type?: string;
  /** Replace the node's tags (identity labels for exact `find` by tag). */
  tags?: string[];
}

export class Mutator {
  constructor(
    private readonly tree: ArtifactTree,
    private readonly addressing: Addressing,
    private readonly log: EventLog,
    private readonly deps: MutatorDeps,
  ) {}

  private resolve(ref: Ref): ArbNode {
    const node = "id" in ref ? this.addressing.byId(ref.id) : this.addressing.byPath(ref.path);
    if (!node) throw new NodeNotFoundError(ref);
    return node;
  }

  private checkScope(node: ArbNode, writeScope?: string): void {
    if (writeScope === undefined) return;
    const path = this.addressing.pathOf(node.id);
    if (path !== writeScope && !path.startsWith(writeScope + "/")) {
      throw new ScopeViolationError(path, writeScope);
    }
  }

  private checkVersion(node: ArbNode, ifVersion?: number): void {
    if (ifVersion !== undefined && node.meta.version !== ifVersion) {
      throw new StaleVersionError(node.id, ifVersion, node.meta.version);
    }
  }

  private bump(node: ArbNode, owner?: string): void {
    node.meta.version += 1;
    node.meta.updatedAt = this.deps.clock.now();
    if (owner !== undefined) node.meta.owner = owner;
  }

  set(ref: Ref, value: Json, opts: MutateOpts = {}): void {
    const node = this.resolve(ref);
    this.checkScope(node, opts.writeScope);
    this.checkVersion(node, opts.ifVersion);
    const type = opts.type ?? node.type;
    this.deps.validate?.({ node, proposed: value, type, op: "set" });
    const before = this.tree.toJson(node.id);
    this.tree.replaceValue(node.id, value, type);
    if (opts.tags !== undefined) node.tags = opts.tags;
    this.bump(node, opts.owner);
    this.log.append({
      kind: "set",
      targetId: node.id,
      parentId: node.parentId,
      key: node.key,
      before,
      after: value,
      actor: opts.owner,
      ts: this.deps.clock.now(),
    });
  }

  insert(parentRef: Ref, keyOrIndex: string | number, value: Json, opts: MutateOpts = {}): NodeId {
    const parent = this.resolve(parentRef);
    this.checkScope(parent, opts.writeScope);
    this.checkVersion(parent, opts.ifVersion);
    const type = opts.type;
    this.deps.validate?.({ node: null, proposed: value, type, op: "insert" });
    const newId = this.tree.insertChild(parent.id, keyOrIndex, value, type);
    const child = this.tree.get(newId)!;
    if (opts.tags !== undefined) child.tags = opts.tags;
    this.bump(parent, opts.owner);
    this.log.append({
      kind: "insert",
      targetId: newId,
      parentId: parent.id,
      key: child.key,
      after: value,
      actor: opts.owner,
      ts: this.deps.clock.now(),
    });
    return newId;
  }

  remove(ref: Ref, opts: MutateOpts = {}): void {
    const node = this.resolve(ref);
    if (node.parentId === null) throw new InvalidOpError("cannot remove the root");
    this.checkScope(node, opts.writeScope);
    this.checkVersion(node, opts.ifVersion);
    const before = this.tree.toJson(node.id);
    const parent = this.tree.get(node.parentId)!;
    const removedKey = node.key;
    this.tree.removeChild(node.parentId, node.id);
    this.bump(parent, opts.owner);
    this.log.append({
      kind: "remove",
      targetId: node.id,
      parentId: parent.id,
      key: removedKey,
      before,
      actor: opts.owner,
      ts: this.deps.clock.now(),
    });
  }

  move(ref: Ref, toParentRef: Ref, keyOrIndex: string | number, opts: MutateOpts = {}): void {
    const node = this.resolve(ref);
    if (node.parentId === null) throw new InvalidOpError("cannot move the root");
    const toParent = this.resolve(toParentRef);
    this.checkScope(node, opts.writeScope);
    this.checkScope(toParent, opts.writeScope);
    this.checkVersion(node, opts.ifVersion);
    const oldParentId = node.parentId;
    const from = { parentId: node.parentId, key: node.key };
    this.tree.moveNode(node.id, toParent.id, keyOrIndex);
    // bump moved node + both parents (dedupe if old === new parent)
    const bumped = new Set<NodeId>();
    for (const id of [node.id, oldParentId, toParent.id]) {
      if (id !== null && !bumped.has(id)) {
        const n = this.tree.get(id);
        if (n) this.bump(n, opts.owner);
        bumped.add(id);
      }
    }
    this.log.append({
      kind: "move",
      targetId: node.id,
      parentId: toParent.id,
      key: node.key,
      from,
      to: { parentId: toParent.id, key: node.key },
      actor: opts.owner,
      ts: this.deps.clock.now(),
    });
  }

  /** Run `fn` atomically: if it throws, the tree and log are restored to their pre-transaction state. */
  transaction(fn: () => void): void {
    const snap = this.tree.snapshot();
    const logLen = this.log.length();
    try {
      fn();
    } catch (err) {
      this.tree.restore(snap);
      this.log.truncateTo(logLen);
      throw err;
    }
  }
}
