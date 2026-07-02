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
  type FindHit,
} from "./navigator";
import type { SearchOpts, SearchResult } from "./semantic-index";
import { type Ref, ArborError, ScopeViolationError, InvalidOpError, NodeNotFoundError } from "./errors";
import type { Json, NodeId } from "./types";

/** Every toolset call returns this — errors are structured, never thrown across the agent boundary. */
export type ToolResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

export type PatchOp =
  | { op: "set"; value: Json; ifVersion?: number }
  | { op: "insert"; key: string | number; value: Json; ifVersion?: number }
  | { op: "remove"; ifVersion?: number }
  | { op: "move"; to: Ref; key: string | number; ifVersion?: number };

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

export interface Toolset {
  describe(ref?: Ref, opts?: DescribeOpts): Promise<ToolResult<DescribeResult>>;
  get(ref: Ref, opts?: GetOpts): Promise<ToolResult<GetResult>>;
  find(selector: FindSelector, opts?: FindOpts): Promise<ToolResult<FindHit[]>>;
  search(query: string, opts?: SearchOpts): Promise<ToolResult<SearchResult>>;
  patch(ref: Ref, op: PatchOp): Promise<ToolResult<{ id?: NodeId }>>;
  history(ref?: Ref, opts?: { limit?: number }): Promise<ToolResult<MutationEvent[]>>;
}

/** path is within scope if scope is unset, equal, or an ancestor prefix. */
function within(path: string, scope: string | undefined): boolean {
  return scope === undefined || path === scope || path.startsWith(scope + "/");
}

/** An event is within scope if any of its recorded paths is within scope. */
function eventWithinScope(e: MutationEvent, scope: string): boolean {
  if (e.path !== undefined && within(e.path, scope)) return true;
  if (e.toPath !== undefined && within(e.toPath, scope)) return true;
  if (e.fromPath !== undefined && within(e.fromPath, scope)) return true;
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
        if (!within(r.node.path, binding.readScope)) {
          throw new ScopeViolationError(r.node.path, binding.readScope!);
        }
        return r;
      }),

    get: (ref, opts) =>
      run(() => {
        const r = navigator.get(ref, opts);
        if (!within(r.path, binding.readScope)) {
          throw new ScopeViolationError(r.path, binding.readScope!);
        }
        // Deep-clone the WHOLE result: `content` (and `meta`) come from the live
        // tree by reference; handing them across the agent boundary would let a
        // caller mutate the artifact without an event, bypassing write-scope.
        return structuredClone(r);
      }),

    find: (selector, opts) =>
      run(() => navigator.find(selector, { ...opts, within: binding.readScope })),

    search: (query, opts = {}) =>
      run(async () => {
        if (!deps.index) throw new InvalidOpError("no semantic index configured for this toolset");
        if (binding.readScope !== undefined && opts.under !== undefined && !within(opts.under, binding.readScope)) {
          throw new ScopeViolationError(opts.under, binding.readScope);
        }
        const under = opts.under ?? binding.readScope;
        return deps.index.search(query, { ...opts, under });
      }),

    patch: (ref, op) =>
      run<{ id?: NodeId }>(() => {
        const common = { owner: binding.owner, writeScope: binding.writeScope, ifVersion: op.ifVersion };
        switch (op.op) {
          case "set":
            deps.mutator.set(ref, op.value, common);
            return {};
          case "insert":
            return { id: deps.mutator.insert(ref, op.key, op.value, common) };
          case "remove":
            deps.mutator.remove(ref, common);
            return {};
          case "move":
            deps.mutator.move(ref, op.to, op.key, common);
            return {};
        }
      }),

    history: (ref, opts = {}) =>
      run(() => {
        let events = [...deps.log.entries()];
        if (ref !== undefined) {
          const node = "id" in ref ? addressing.byId(ref.id) : addressing.byPath(ref.path);
          if (!node) throw new NodeNotFoundError(ref);
          const path = addressing.pathOf(node.id);
          if (!within(path, binding.readScope)) throw new ScopeViolationError(path, binding.readScope!);
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
