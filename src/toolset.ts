import type { ArtifactTree } from "./artifact-tree";
import type { Addressing } from "./addressing";
import type { EventLog, MutationEvent } from "./event-log";
import type { Mutator } from "./mutator";
import type { SemanticIndex } from "./semantic-index";
import {
  Navigator,
  type DescribeOpts,
  type DescribeResult,
  type GetOpts,
  type GetResult,
  type FindSelector,
  type FindOpts,
  type FindResult,
} from "./navigator";
import type { SearchOpts, SearchResult } from "./semantic-index";
import { type Ref, ArborError, ScopeViolationError, InvalidOpError, NodeNotFoundError } from "./errors";
import { isWithin } from "./jsonpointer";
import type { Json, NodeId } from "./types";

/** Every toolset call returns this — errors are structured, never thrown across the agent boundary. */
export type ToolResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

/** `edit` is exact-substring surgery on a string leaf — pure sugar over `set`: the event
 *  log records a plain `set` with the full before/after value, so history/revert/replay/
 *  AG-UI need nothing new. `old` must match the live value exactly (and uniquely, unless
 *  `replaceAll`) — `get` the node first and quote `old` from what it returns. */
export type PatchOp =
  | { op: "set"; value: Json; ifVersion?: number }
  | { op: "insert"; key: string | number; value: Json; ifVersion?: number }
  | { op: "remove"; ifVersion?: number }
  | { op: "move"; to: Ref; key: string | number; ifVersion?: number }
  | { op: "edit"; old: string; new: string; replaceAll?: boolean; ifVersion?: number };

export interface ToolsetDeps {
  tree: ArtifactTree;
  addressing: Addressing;
  log: EventLog;
  mutator: Mutator;
  index?: SemanticIndex;
}

export interface ToolsetBinding {
  owner?: string;
  /** JSON Pointer prefix: writes must be at or under it (enforced by the Mutator). */
  writeScope?: string;
  /** JSON Pointer prefix: reads are confined to it. */
  readScope?: string;
}

export interface PatchResult {
  id: NodeId;
  path: string;
  /** The affected node's version AFTER the op (remove: the parent's). Feed into the next ifVersion. */
  version: number;
}

export interface Toolset {
  describe(ref?: Ref, opts?: DescribeOpts): Promise<ToolResult<DescribeResult>>;
  get(ref: Ref, opts?: GetOpts): Promise<ToolResult<GetResult>>;
  find(selector: FindSelector, opts?: FindOpts): Promise<ToolResult<FindResult>>;
  search(query: string, opts?: SearchOpts): Promise<ToolResult<SearchResult>>;
  patch(ref: Ref, op: PatchOp): Promise<ToolResult<PatchResult>>;
  history(ref?: Ref, opts?: { limit?: number }): Promise<ToolResult<MutationEvent[]>>;
}

/** An event is within scope if any of its recorded paths is within scope. */
function eventWithinScope(e: MutationEvent, scope: string): boolean {
  if (e.path !== undefined && isWithin(e.path, scope)) return true;
  if (e.toPath !== undefined && isWithin(e.toPath, scope)) return true;
  if (e.fromPath !== undefined && isWithin(e.fromPath, scope)) return true;
  return false;
}

/** Run a tool body, converting thrown errors into a structured ToolResult. */
async function run<T>(fn: () => T | Promise<T>): Promise<ToolResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    if (e instanceof ArborError) return { ok: false, error: { code: e.code, message: e.message } };
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: { code: "ERROR", message } };
  }
}

/** A scoped, agent-facing bundle of tools returning structured results. */
export function makeToolset(deps: ToolsetDeps, binding: ToolsetBinding = {}): Toolset {
  const { tree, addressing } = deps;
  const navigator = new Navigator(tree, addressing);

  return {
    describe: (ref, opts) =>
      run(() => {
        const target: Ref = ref ?? (binding.readScope !== undefined ? { path: binding.readScope } : { path: "" });
        const r = navigator.describe(target, opts);
        if (!isWithin(r.node.path, binding.readScope)) {
          throw new ScopeViolationError(r.node.path, binding.readScope!);
        }
        return r;
      }),

    get: (ref, opts) =>
      run(() => {
        const r = navigator.get(ref, opts);
        if (!isWithin(r.path, binding.readScope)) {
          throw new ScopeViolationError(r.path, binding.readScope!);
        }
        // Deep-clone the WHOLE result: `content` (and `meta`) come from the live
        // tree by reference; handing them across the agent boundary would let a
        // caller mutate the artifact without an event, bypassing write-scope.
        return structuredClone(r);
      }),

    find: (selector, opts) =>
      run(() => {
        if (binding.readScope !== undefined && opts?.within !== undefined && !isWithin(opts.within, binding.readScope)) {
          throw new ScopeViolationError(opts.within, binding.readScope);
        }
        return navigator.find(selector, { ...opts, within: opts?.within ?? binding.readScope });
      }),

    search: (query, opts = {}) =>
      run(async () => {
        if (!deps.index) throw new InvalidOpError("no semantic index configured for this toolset");
        if (binding.readScope !== undefined && opts.under !== undefined && !isWithin(opts.under, binding.readScope)) {
          throw new ScopeViolationError(opts.under, binding.readScope);
        }
        const under = opts.under ?? binding.readScope;
        return deps.index.search(query, { ...opts, under });
      }),

    patch: (ref, op) =>
      run<PatchResult>(() => {
        const common = { owner: binding.owner, writeScope: binding.writeScope, ifVersion: op.ifVersion };
        const resolve = (r: Ref) => {
          const node = "id" in r ? addressing.byId(r.id) : addressing.byPath(r.path);
          if (!node) throw new NodeNotFoundError(r);
          return node;
        };
        switch (op.op) {
          case "set": {
            deps.mutator.set(ref, op.value, common);
            const node = resolve(ref);
            return { id: node.id, path: addressing.pathOf(node.id), version: node.meta.version };
          }
          case "insert": {
            const id = deps.mutator.insert(ref, op.key, op.value, common);
            const node = tree.get(id)!;
            return { id, path: addressing.pathOf(id), version: node.meta.version };
          }
          case "remove": {
            const node = resolve(ref);
            const removed = { id: node.id, path: addressing.pathOf(node.id) };
            const parentId = node.parentId;
            deps.mutator.remove(ref, common);
            const parent = parentId !== null ? tree.get(parentId) : undefined;
            return { id: removed.id, path: removed.path, version: parent?.meta.version ?? 0 };
          }
          case "move": {
            const node = resolve(ref);
            deps.mutator.move(ref, op.to, op.key, common);
            return { id: node.id, path: addressing.pathOf(node.id), version: node.meta.version };
          }
          case "edit": {
            const node = resolve(ref);
            const path = addressing.pathOf(node.id);
            const value = tree.toJson(node.id);
            if (typeof value !== "string") {
              const kind = Array.isArray(value) ? "an array" : typeof value;
              throw new InvalidOpError(
                `edit targets string values; ${path} is ${kind} — target a string field inside it`,
              );
            }
            if (op.old === "") throw new InvalidOpError("edit: old must be non-empty");
            if (op.old === op.new) throw new InvalidOpError("edit: old and new are identical");
            const count = value.split(op.old).length - 1;
            if (count === 0) throw new InvalidOpError(`edit: old string not found in ${path}`);
            if (count > 1 && !op.replaceAll) {
              throw new InvalidOpError(
                `edit: old string occurs ${count} times in ${path} — quote a larger unique fragment or set replaceAll`,
              );
            }
            // split/join instead of String.replace: replace() interprets `$&` etc. in the
            // replacement string, which would corrupt an exact-substring edit. When count
            // is 1 the two are equivalent anyway.
            const next = value.split(op.old).join(op.new);
            deps.mutator.set(ref, next, common);
            const after = resolve(ref);
            return { id: after.id, path: addressing.pathOf(after.id), version: after.meta.version };
          }
        }
      }),

    history: (ref, opts = {}) =>
      run(() => {
        let events = [...deps.log.entries()];
        if (ref !== undefined) {
          const node = "id" in ref ? addressing.byId(ref.id) : addressing.byPath(ref.path);
          if (!node) throw new NodeNotFoundError(ref);
          const path = addressing.pathOf(node.id);
          if (!isWithin(path, binding.readScope)) throw new ScopeViolationError(path, binding.readScope!);
          const id = node.id;
          events = events.filter((e) => e.targetId === id);
        } else if (binding.readScope !== undefined) {
          const scope = binding.readScope;
          events = events.filter((e) => eventWithinScope(e, scope));
        }
        return structuredClone(opts.limit !== undefined ? events.slice(-opts.limit) : events);
      }),
  };
}
