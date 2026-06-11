import type { ArtifactTree } from "./artifact-tree";
import type { Addressing } from "./addressing";
import type { EventLog } from "./event-log";
import type { Mutator } from "./mutator";
import type { SemanticIndex } from "./semantic-index";
import {
  Navigator,
  type DescribeOpts,
  type DescribeResult,
  type GetOpts,
  type GetResult,
} from "./navigator";
import { type Ref, ArborError, ScopeViolationError } from "./errors";

/** Every toolset call returns this — errors are structured, never thrown across the agent boundary. */
export type ToolResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

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
}

/** path is within scope if scope is unset, equal, or an ancestor prefix. */
function within(path: string, scope: string | undefined): boolean {
  return scope === undefined || path === scope || path.startsWith(scope + "/");
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
        return { ...r, meta: structuredClone(r.meta) };
      }),
  };
}
