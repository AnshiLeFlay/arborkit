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
    this.deps.validate?.({ node, proposed: value, type: node.type, op: "set" });
    const before = this.tree.toJson(node.id);
    this.tree.replaceValue(node.id, value);
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
    this.deps.validate?.({ node: null, proposed: value, type: undefined, op: "insert" });
    const newId = this.tree.insertChild(parent.id, keyOrIndex, value);
    this.bump(parent, opts.owner);
    const child = this.tree.get(newId)!;
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
}
