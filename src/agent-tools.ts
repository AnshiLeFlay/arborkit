import type { PatchStep, Toolset, ToolResult } from "./toolset";
import type { Json } from "./types";

/**
 * Provider-neutral LLM tool definitions plus a never-throw executor over a
 * scoped ArborKit Toolset. Definitions are plain JSON Schema; runtime/model
 * adapters remain outside the zero-dependency core.
 *
 * Usage:
 *   const defs = agentToolDefs({ profile: "editor" });
 *   const exec = makeToolExecutor(toolset, { profile: "editor", guard, approval });
 *   const resultJson = await exec(call.name, call.input);
 */

export type AgentToolName =
  | "search"
  | "find"
  | "describe"
  | "get"
  | "edit"
  | "set_value"
  | "insert"
  | "remove"
  | "move"
  | "batch_patch"
  | "history"
  | "get_at"
  | "revert";

export type AgentToolProfile = "reader" | "editor" | "admin";

/** Plain JSON tool definition. LangChain bindTools accepts `schema` as-is;
 * Anthropic callers rename it to `input_schema`. `outputSchema` describes the
 * serialized ToolResult returned by makeToolExecutor. */
export interface AgentToolDef {
  name: AgentToolName;
  description: string;
  schema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export const DEFAULT_MAX_RESULT_CHARS = 20_000;

export interface ToolRefusal {
  code: string;
  message: string;
}

/** Operation-level domain veto. For batch_patch it is called once per contained
 * operation, before the atomic batch starts. Sync and async guards are accepted. */
export type ToolGuard = (
  toolName: AgentToolName,
  input: Record<string, unknown>,
) => ToolRefusal | null | undefined | Promise<ToolRefusal | null | undefined>;

/** Human/policy approval hook. `false` returns APPROVAL_DENIED before dispatch.
 * For batch_patch every contained operation must be approved before any write. */
export type ToolApproval = (
  toolName: AgentToolName,
  input: Record<string, unknown>,
) => boolean | Promise<boolean>;

const str = Object.freeze({ type: "string" } as const);
const int = Object.freeze({ type: "integer" } as const);
const bool = Object.freeze({ type: "boolean" } as const);
const key = Object.freeze({ oneOf: [str, int] } as const);
const anyJson = Object.freeze({ description: "Any JSON value" } as const);
const freshness = Object.freeze({ type: "string", enum: ["best-effort", "wait"] } as const);

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

const patchResultSchema = Object.freeze({
  type: "object",
  properties: { id: str, path: str, version: int },
  required: ["id", "path", "version"],
  additionalProperties: false,
} as const);

function resultSchema(value: Record<string, unknown>): Record<string, unknown> {
  return {
    oneOf: [
      {
        type: "object",
        properties: { ok: { const: true }, value },
        required: ["ok", "value"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          ok: { const: false },
          error: objectSchema({ code: str, message: str }, ["code", "message"]),
        },
        required: ["ok", "error"],
        additionalProperties: false,
      },
    ],
  };
}

function mutationSchemas(): Record<"edit" | "set_value" | "insert" | "remove" | "move", Record<string, unknown>> {
  return {
    edit: objectSchema(
      { op: { const: "edit" }, path: str, old: str, new: str, replaceAll: bool, ifVersion: int },
      ["op", "path", "old", "new"],
    ),
    set_value: objectSchema(
      { op: { const: "set_value" }, path: str, value: anyJson, ifVersion: int },
      ["op", "path", "value"],
    ),
    insert: objectSchema(
      { op: { const: "insert" }, path: str, key, value: anyJson, ifVersion: int },
      ["op", "path", "key", "value"],
    ),
    remove: objectSchema({ op: { const: "remove" }, path: str, ifVersion: int }, ["op", "path"]),
    move: objectSchema(
      { op: { const: "move" }, path: str, toPath: str, key, ifVersion: int },
      ["op", "path", "toPath", "key"],
    ),
  };
}

function makeDefs(): AgentToolDef[] {
  const mutations = mutationSchemas();
  return [
    {
      name: "search",
      description:
        "Semantic search by meaning. Filter with under/type/tag; freshness=wait reindexes before searching.",
      schema: objectSchema(
        { query: str, k: int, under: str, type: str, tag: str, freshness },
        ["query"],
      ),
      outputSchema: resultSchema({ description: "SearchResult with ranked results and staleCount" }),
    },
    {
      name: "find",
      description:
        "Exact lookup by path glob, type, or tag. Returns {hits, truncated}; narrow the selector when truncated.",
      schema: objectSchema({ pathPattern: str, type: str, tag: str, limit: int }),
      outputSchema: resultSchema({ description: "FindResult with exact hits and truncation flag" }),
    },
    {
      name: "describe",
      description: "Structure overview of a node: children, types, and sizes. Start here before reading values.",
      schema: objectSchema({ path: str }),
      outputSchema: resultSchema({ description: "DescribeResult" }),
    },
    {
      name: "get",
      description:
        'Full value of a node. Get immediately before editing and quote "old" from the exact returned text.',
      schema: objectSchema({ path: str, maxDepth: int }, ["path"]),
      outputSchema: resultSchema({ description: "GetResult with content and node metadata" }),
    },
    {
      name: "edit",
      description:
        'Default string write: replace an exact substring. "old" must be unique unless replaceAll is true; pass ifVersion from get to prevent lost updates.',
      schema: objectSchema(
        { path: str, old: str, new: str, replaceAll: bool, ifVersion: int },
        ["path", "old", "new"],
      ),
      outputSchema: resultSchema(patchResultSchema),
    },
    {
      name: "set_value",
      description: "Replace an entire node value. Prefer edit for small string changes; pass ifVersion after a read.",
      schema: objectSchema({ path: str, value: anyJson, ifVersion: int }, ["path", "value"]),
      outputSchema: resultSchema(patchResultSchema),
    },
    {
      name: "insert",
      description:
        "Insert a new child into the object/array at path. ifVersion compares the parent container version.",
      schema: objectSchema({ path: str, key, value: anyJson, ifVersion: int }, ["path", "key", "value"]),
      outputSchema: resultSchema(patchResultSchema),
    },
    {
      name: "remove",
      description: "Remove a node. This is destructive; pass ifVersion from a recent get when possible.",
      schema: objectSchema({ path: str, ifVersion: int }, ["path"]),
      outputSchema: resultSchema(patchResultSchema),
    },
    {
      name: "move",
      description: "Move a node to a new parent path and key/index. The source and destination must be writable.",
      schema: objectSchema({ path: str, toPath: str, key, ifVersion: int }, ["path", "toPath", "key"]),
      outputSchema: resultSchema(patchResultSchema),
    },
    {
      name: "batch_patch",
      description:
        "Apply set/edit/insert/remove/move operations atomically. If any operation fails, every earlier operation is rolled back.",
      schema: objectSchema(
        {
          operations: {
            type: "array",
            minItems: 1,
            items: { oneOf: [mutations.edit, mutations.set_value, mutations.insert, mutations.remove, mutations.move] },
          },
        },
        ["operations"],
      ),
      outputSchema: resultSchema({ type: "array", items: patchResultSchema }),
    },
    {
      name: "history",
      description: "Recent mutation events for a node, including actor and before/after values.",
      schema: objectSchema({ path: str, limit: int }),
      outputSchema: resultSchema({ type: "array", description: "Mutation events" }),
    },
    {
      name: "get_at",
      description: "Read a node value as of a past event-log version.",
      schema: objectSchema({ path: str, version: int }, ["path", "version"]),
      outputSchema: resultSchema(
        objectSchema({ value: { description: "Past JSON value, or null" }, existed: bool }, ["value", "existed"]),
      ),
    },
    {
      name: "revert",
      description:
        "Restore a node to a past version as a new append-only change. Use get_at first to confirm the state.",
      schema: objectSchema({ path: str, version: int }, ["path", "version"]),
      outputSchema: resultSchema(patchResultSchema),
    },
  ];
}

const TOOL_NAMES: readonly AgentToolName[] = Object.freeze([
  "search",
  "find",
  "describe",
  "get",
  "edit",
  "set_value",
  "insert",
  "remove",
  "move",
  "batch_patch",
  "history",
  "get_at",
  "revert",
]);
const LEGACY_DEFAULT_TOOLS: readonly AgentToolName[] = Object.freeze([
  "search",
  "find",
  "describe",
  "get",
  "edit",
  "set_value",
  "history",
  "get_at",
  "revert",
]);

/** Conservative capability presets. editor omits destructive remove/revert and
 * unrestricted batch_patch; admin exposes the complete bridge. */
const READER_TOOLS: readonly AgentToolName[] = Object.freeze([
  "search",
  "find",
  "describe",
  "get",
  "history",
  "get_at",
]);
const EDITOR_TOOLS: readonly AgentToolName[] = Object.freeze([
  "search",
  "find",
  "describe",
  "get",
  "edit",
  "set_value",
  "insert",
  "move",
  "history",
  "get_at",
]);

export const AGENT_TOOL_PROFILES: Readonly<Record<AgentToolProfile, readonly AgentToolName[]>> = Object.freeze({
  reader: READER_TOOLS,
  editor: EDITOR_TOOLS,
  admin: TOOL_NAMES,
});

export interface AgentToolSurfaceOptions {
  profile?: AgentToolProfile;
  include?: AgentToolName[];
}

function allowedNames(opts: AgentToolSurfaceOptions): readonly AgentToolName[] {
  // No options preserves the v1.2 nine-tool surface. New mutation capabilities
  // require an explicit profile or include, so a minor upgrade cannot silently
  // grant destructive tools to an existing model.
  const profileNames =
    opts.profile !== undefined
      ? AGENT_TOOL_PROFILES[opts.profile]
      : opts.include === undefined
        ? LEGACY_DEFAULT_TOOLS
        : TOOL_NAMES;
  const requested = opts.include === undefined ? undefined : new Set(opts.include);
  return TOOL_NAMES.filter((name) => profileNames.includes(name) && (requested === undefined || requested.has(name)));
}

/** Build fresh definitions in canonical order. `profile` selects a safe preset;
 * `include` further narrows it (intersection, never escalation). */
export function agentToolDefs(opts: AgentToolSurfaceOptions = {}): AgentToolDef[] {
  const allowed = new Set(allowedNames(opts));
  return makeDefs().filter((definition) => allowed.has(definition.name));
}

class InputError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== "string") throw new InputError(`field "${field}" must be a string (required)`);
  return value;
}

function optionalString(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new InputError(`field "${field}" must be a string`);
  return value;
}

function requireInt(input: Record<string, unknown>, field: string): number {
  const value = input[field];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new InputError(`field "${field}" must be an integer (required)`);
  }
  return value;
}

function optionalInt(input: Record<string, unknown>, field: string): number | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new InputError(`field "${field}" must be an integer`);
  }
  return value;
}

function optionalBool(input: Record<string, unknown>, field: string): boolean | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new InputError(`field "${field}" must be a boolean`);
  return value;
}

function requireKey(input: Record<string, unknown>, field: string): string | number {
  const value = input[field];
  if (typeof value === "string" || (typeof value === "number" && Number.isInteger(value))) return value;
  throw new InputError(`field "${field}" must be a string or integer (required)`);
}

function requireJson(input: Record<string, unknown>, field: string): Json {
  if (!(field in input) || input[field] === undefined) {
    throw new InputError(`field "${field}" must be present and not undefined (required)`);
  }
  return structuredClone(input[field]) as Json;
}

function optionalFreshness(input: Record<string, unknown>): "best-effort" | "wait" | undefined {
  const value = input["freshness"];
  if (value === undefined) return undefined;
  if (value !== "best-effort" && value !== "wait") {
    throw new InputError('field "freshness" must be "best-effort" or "wait"');
  }
  return value;
}

type MutationToolName = "edit" | "set_value" | "insert" | "remove" | "move";

function mutationStep(name: MutationToolName, input: Record<string, unknown>): PatchStep {
  const path = requireString(input, "path");
  const ifVersion = optionalInt(input, "ifVersion");
  switch (name) {
    case "edit":
      return {
        ref: { path },
        op: {
          op: "edit",
          old: requireString(input, "old"),
          new: requireString(input, "new"),
          replaceAll: optionalBool(input, "replaceAll"),
          ifVersion,
        },
      };
    case "set_value":
      return { ref: { path }, op: { op: "set", value: requireJson(input, "value"), ifVersion } };
    case "insert":
      return {
        ref: { path },
        op: { op: "insert", key: requireKey(input, "key"), value: requireJson(input, "value"), ifVersion },
      };
    case "remove":
      return { ref: { path }, op: { op: "remove", ifVersion } };
    case "move":
      return {
        ref: { path },
        op: { op: "move", to: { path: requireString(input, "toPath") }, key: requireKey(input, "key"), ifVersion },
      };
  }
}

type Dispatch = (toolset: Toolset) => Promise<ToolResult<unknown>>;
interface OperationCheck {
  name: AgentToolName;
  input: Record<string, unknown>;
}
interface ExecutionPlan {
  dispatch: Dispatch;
  checks: OperationCheck[];
}

function plan(name: AgentToolName, input: Record<string, unknown>): ExecutionPlan {
  const single = (dispatch: Dispatch): ExecutionPlan => ({ dispatch, checks: [{ name, input }] });
  switch (name) {
    case "search": {
      const query = requireString(input, "query");
      const k = optionalInt(input, "k");
      const under = optionalString(input, "under");
      const type = optionalString(input, "type");
      const tag = optionalString(input, "tag");
      const searchFreshness = optionalFreshness(input);
      return single((toolset) => toolset.search(query, { k, under, type, tag, freshness: searchFreshness }));
    }
    case "find": {
      const pathPattern = optionalString(input, "pathPattern");
      const type = optionalString(input, "type");
      const tag = optionalString(input, "tag");
      const limit = optionalInt(input, "limit");
      return single((toolset) => toolset.find({ pathPattern, type, tag }, { limit }));
    }
    case "describe": {
      const path = optionalString(input, "path");
      return single((toolset) => toolset.describe(path === undefined ? undefined : { path }));
    }
    case "get": {
      const path = requireString(input, "path");
      const maxDepth = optionalInt(input, "maxDepth");
      return single((toolset) => toolset.get({ path }, { maxDepth }));
    }
    case "edit":
    case "set_value":
    case "insert":
    case "remove":
    case "move": {
      const step = mutationStep(name, input);
      return single((toolset) => toolset.patch(step.ref, step.op));
    }
    case "batch_patch": {
      const rawOperations = input["operations"];
      if (!Array.isArray(rawOperations) || rawOperations.length === 0) {
        throw new InputError('field "operations" must be a non-empty array (required)');
      }
      const steps: PatchStep[] = [];
      const checks: OperationCheck[] = [];
      const mutationNames: readonly MutationToolName[] = ["edit", "set_value", "insert", "remove", "move"];
      for (const [index, raw] of rawOperations.entries()) {
        if (!isPlainObject(raw)) throw new InputError(`operations[${index}] must be a JSON object`);
        const op = raw["op"];
        if (typeof op !== "string" || !(mutationNames as readonly string[]).includes(op)) {
          throw new InputError(`operations[${index}].op must be one of: ${mutationNames.join(", ")}`);
        }
        const operationName = op as MutationToolName;
        try {
          steps.push(mutationStep(operationName, raw));
        } catch (error) {
          if (error instanceof InputError) throw new InputError(`operations[${index}]: ${error.message}`);
          throw error;
        }
        checks.push({ name: operationName, input: raw });
      }
      return { dispatch: (toolset) => toolset.batchPatch(steps), checks };
    }
    case "history": {
      const path = optionalString(input, "path");
      const limit = optionalInt(input, "limit");
      return single((toolset) => toolset.history(path === undefined ? undefined : { path }, { limit }));
    }
    case "get_at": {
      const path = requireString(input, "path");
      const version = requireInt(input, "version");
      return single((toolset) => toolset.getAt({ path }, version));
    }
    case "revert": {
      const path = requireString(input, "path");
      const version = requireInt(input, "version");
      return single((toolset) => toolset.revert({ path }, version));
    }
  }
}

function errorResult(code: string, message: string): string {
  return JSON.stringify({ ok: false, error: { code, message } });
}

function normalizeRefusal(refusal: unknown): ToolRefusal {
  if (
    typeof refusal === "object" &&
    refusal !== null &&
    typeof (refusal as { code?: unknown }).code === "string" &&
    typeof (refusal as { message?: unknown }).message === "string"
  ) {
    return refusal as ToolRefusal;
  }
  return { code: "GUARD_REFUSED", message: String(refusal) };
}

export interface ToolExecutorOptions extends AgentToolSurfaceOptions {
  maxResultChars?: number;
  guard?: ToolGuard;
  approval?: ToolApproval;
}

/** Build a never-throw `(toolName, input) -> JSON string` executor. Validation,
 * every batch guard, and every approval complete before dispatch starts. */
export function makeToolExecutor(
  toolset: Toolset,
  opts: ToolExecutorOptions = {},
): (toolName: string, input: unknown) => Promise<string> {
  const cap = opts.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const allowed = allowedNames(opts);
  return async (toolName, input) => {
    if (!(allowed as readonly string[]).includes(toolName)) {
      return errorResult(
        "UNKNOWN_TOOL",
        allowed.length === 0
          ? `unknown tool ${toolName}; no tools are enabled`
          : `unknown tool ${toolName}; available: ${allowed.join(", ")}`,
      );
    }
    const name = toolName as AgentToolName;
    if (!isPlainObject(input)) return errorResult("INVALID_INPUT", `input for ${name} must be a JSON object`);

    let result: ToolResult<unknown>;
    try {
      const execution = plan(name, input);
      for (const operation of execution.checks) {
        const refusal = opts.guard === undefined ? null : await opts.guard(operation.name, operation.input);
        if (refusal != null) {
          return JSON.stringify({ ok: false, error: normalizeRefusal(refusal) });
        }
        if (opts.approval !== undefined && (await opts.approval(operation.name, operation.input)) !== true) {
          return errorResult("APPROVAL_DENIED", `approval denied for ${operation.name}`);
        }
      }
      result = await execution.dispatch(toolset);
    } catch (error) {
      if (error instanceof InputError) return errorResult("INVALID_INPUT", error.message);
      return errorResult("EXECUTOR_ERROR", error instanceof Error ? error.message : String(error));
    }

    const serialized = JSON.stringify(result);
    if (result.ok && serialized.length > cap) {
      return errorResult(
        "TOO_LARGE",
        `result is ${serialized.length} chars (cap ${cap}) — narrow the request and retry: ` +
          `use a more specific path, lower maxDepth on get, or reduce k/limit`,
      );
    }
    return serialized;
  };
}
