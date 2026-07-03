import type { ArbNode, Json, NodeId } from "./types";
import type { Clock } from "./clock";
import type { ArtifactTree } from "./artifact-tree";
import type { Addressing } from "./addressing";
import type { EventLog, OpKind } from "./event-log";
import { type Ref, NodeNotFoundError, ScopeViolationError, StaleVersionError, InvalidOpError } from "./errors";
import { isWithin } from "./jsonpointer";

/** Optional validation hook. Throws to reject a mutation. M3 plugs Zod in here. */
export type Validator = (input: { node: ArbNode | null; proposed: Json; type?: string; op: OpKind }) => void;

export interface MutatorDeps {
  clock: Clock;
  validate?: Validator;
  /** Called after a node's content changes (set/insert) — e.g. to mark a semantic index stale. */
  onChange?: (node: ArbNode) => void;
  /** Called after a node is removed — e.g. to drop it from a semantic index. */
  onRemove?: (nodeId: NodeId) => void;
  /** Called at transaction start; the returned snapshot is passed to `onTxRestore` on rollback. */
  onTxSnapshot?: () => unknown;
  /** Called on transaction rollback with the snapshot from `onTxSnapshot`. */
  onTxRestore?: (snapshot: unknown) => void;
}

export interface MutateOpts {
  owner?: string;
  /** JSON Pointer prefix; the target must be at or under it. */
  writeScope?: string;
  /** Optimistic concurrency: reject unless the target's current version equals this. */
  ifVersion?: number;
  /** Register/override the node's type (drives validation and the decompose override).
   *  `null` explicitly CLEARS the type (validation is skipped) — used by type-aware revert. */
  type?: string | null;
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
    if (!isWithin(path, writeScope)) throw new ScopeViolationError(path, writeScope);
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
    // Defensive copy: neither the tree nor the event log may alias the caller's
    // live object — post-call mutation would silently rewrite state AND history.
    const cloned = structuredClone(value);
    const clearType = opts.type === null;
    const type = clearType ? undefined : (opts.type ?? node.type);
    this.deps.validate?.({ node, proposed: cloned, type, op: "set" });
    const before = this.tree.toJson(node.id);
    const typeBefore = node.type;
    const tagsBefore = [...(node.tags ?? [])];
    const orphaned = this.tree.descendantIds(node.id);
    this.tree.replaceValue(node.id, cloned, type, clearType);
    if (opts.tags !== undefined) node.tags = [...opts.tags];
    this.bump(node, opts.owner);
    this.deps.onChange?.(node);
    if (this.deps.onChange) {
      // replaceValue rebuilt the subtree: every descendant is a NEW node and
      // must be announced too (text leaves are what the semantic index embeds).
      for (const id of this.tree.descendantIds(node.id)) {
        const child = this.tree.get(id);
        if (child) this.deps.onChange(child);
      }
    }
    if (this.deps.onRemove) {
      for (const id of orphaned) this.deps.onRemove(id);
    }
    this.log.append({
      kind: "set",
      targetId: node.id,
      parentId: node.parentId,
      key: node.key,
      path: this.addressing.pathOf(node.id),
      before,
      after: cloned,
      nodeTypeBefore: typeBefore ?? null,
      nodeType: type ?? null,
      tagsBefore,
      tags: [...(node.tags ?? [])],
      actor: opts.owner,
      ts: this.deps.clock.now(),
    });
  }

  insert(parentRef: Ref, keyOrIndex: string | number, value: Json, opts: MutateOpts = {}): NodeId {
    const parent = this.resolve(parentRef);
    this.checkScope(parent, opts.writeScope);
    this.checkVersion(parent, opts.ifVersion);
    // Defensive copy: neither the tree nor the event log may alias the caller's
    // live object — post-call mutation would silently rewrite state AND history.
    const cloned = structuredClone(value);
    const type = opts.type === null ? undefined : opts.type;
    this.deps.validate?.({ node: null, proposed: cloned, type, op: "insert" });
    const newId = this.tree.insertChild(parent.id, keyOrIndex, cloned, type);
    const child = this.tree.get(newId)!;
    if (opts.tags !== undefined) child.tags = [...opts.tags];
    this.bump(parent, opts.owner);
    this.deps.onChange?.(child);
    if (this.deps.onChange) {
      for (const id of this.tree.descendantIds(newId)) {
        const desc = this.tree.get(id);
        if (desc) this.deps.onChange(desc);
      }
    }
    this.log.append({
      kind: "insert",
      targetId: newId,
      parentId: parent.id,
      key: child.key,
      path: this.addressing.pathOf(newId),
      after: cloned,
      nodeType: child.type ?? null,
      tags: [...(child.tags ?? [])],
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
    const path = this.addressing.pathOf(node.id);
    const removedIds = [node.id, ...this.tree.descendantIds(node.id)];
    const parent = this.tree.get(node.parentId)!;
    const removedKey = node.key;
    this.tree.removeChild(node.parentId, node.id);
    this.bump(parent, opts.owner);
    if (this.deps.onRemove) {
      for (const id of removedIds) this.deps.onRemove(id);
    }
    // The parent's semantic unit (if any) lost content — re-hash it.
    this.deps.onChange?.(parent);
    this.log.append({
      kind: "remove",
      targetId: node.id,
      parentId: parent.id,
      key: removedKey,
      path,
      before,
      nodeTypeBefore: node.type ?? null,
      tagsBefore: [...(node.tags ?? [])],
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
    const fromPath = this.addressing.pathOf(node.id);
    this.tree.moveNode(node.id, toParent.id, keyOrIndex);
    const toPath = this.addressing.pathOf(node.id);
    // bump moved node + both parents (dedupe if old === new parent)
    const bumped = new Set<NodeId>();
    for (const id of [node.id, oldParentId, toParent.id]) {
      if (id !== null && !bumped.has(id)) {
        const n = this.tree.get(id);
        if (n) this.bump(n, opts.owner);
        bumped.add(id);
      }
    }
    if (this.deps.onChange) {
      // The moved subtree's ancestry changed (suppression status may flip), and
      // both old and new locations' semantic units changed content.
      this.deps.onChange(node);
      for (const id of this.tree.descendantIds(node.id)) {
        const d = this.tree.get(id);
        if (d) this.deps.onChange(d);
      }
      const oldP = oldParentId !== null ? this.tree.get(oldParentId) : undefined;
      if (oldP) this.deps.onChange(oldP);
      const newP = this.tree.get(toParent.id);
      if (newP) this.deps.onChange(newP);
    }
    this.log.append({
      kind: "move",
      targetId: node.id,
      parentId: toParent.id,
      key: node.key,
      from,
      to: { parentId: toParent.id, key: node.key },
      fromPath,
      toPath,
      actor: opts.owner,
      ts: this.deps.clock.now(),
    });
  }

  /** Run `fn` atomically: if it throws, the tree, log, and any hooked index state are restored. */
  transaction(fn: () => void): void {
    const snap = this.tree.snapshot();
    const logLen = this.log.length();
    const hookSnap = this.deps.onTxSnapshot?.();
    try {
      fn();
    } catch (err) {
      this.tree.restore(snap);
      this.log.truncateTo(logLen);
      if (this.deps.onTxRestore) this.deps.onTxRestore(hookSnap);
      throw err;
    }
  }
}
