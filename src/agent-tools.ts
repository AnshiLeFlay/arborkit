import type { Toolset, ToolResult } from "./toolset";
import type { Json } from "./types";

/**
 * Agent bridge: ready-made LLM tool definitions (plain JSON Schema, zero deps)
 * plus a never-throw executor over a `Toolset` — the generic extraction of a
 * production consumer's reviewed LLM↔Arbor bridge. Domain-specific rules (e.g.
 * an HTML tag-balance check) belong in the `guard` hook, not here.
 *
 * Usage:
 *   const defs = agentToolDefs();                    // LangChain bindTools accepts these as-is
 *   const anthropicTools = defs.map((d) => ({ name: d.name, description: d.description, input_schema: d.schema }));
 *   const exec = makeToolExecutor(toolset, { guard: myDomainGuard });
 *   // in the tool-call loop:
 *   const resultJson = await exec(call.name, call.input); // always a JSON string, never throws
 */

/** Plain-JSON tool definition. LangChain's bindTools accepts this shape as-is;
 *  for the Anthropic SDK map it: {name, description, input_schema: schema}. */
export interface AgentToolDef {
  name: string;
  description: string;
  schema: Record<string, unknown>; // JSON Schema (object literal — no runtime dep)
}

export type AgentToolName =
  | "search"
  | "find"
  | "describe"
  | "get"
  | "edit"
  | "set_value"
  | "history"
  | "get_at"
  | "revert";

export const DEFAULT_MAX_RESULT_CHARS = 20_000;

/** Pre-execution veto for domain rules (e.g. an HTML tag-balance check).
 *  Return null to allow; return {code, message} to refuse — the refusal is
 *  serialized back to the agent as {ok:false, error} and the toolset is NOT called. */
export type ToolGuard = (
  toolName: AgentToolName,
  input: Record<string, unknown>,
) => { code: string; message: string } | null;

const str = { type: "string" } as const;
const int = { type: "integer" } as const;
const bool = { type: "boolean" } as const;

function makeDefs(): AgentToolDef[] {
  return [
    {
      name: "search",
      description:
        "Semantic search over the artifact by MEANING. Use this FIRST to locate content when you don't know its path.",
      schema: { type: "object", properties: { query: str, k: int }, required: ["query"] },
    },
    {
      name: "find",
      description:
        "Exact lookup by path glob, type, or tag. Returns {hits, truncated} — truncated=true means narrow the pattern.",
      schema: {
        type: "object",
        properties: { pathPattern: str, type: str, tag: str, limit: int },
        required: [],
      },
    },
    {
      name: "describe",
      description: "Structure overview of a node: children, types, sizes. Start here to orient before reading values.",
      schema: { type: "object", properties: { path: str }, required: [] },
    },
    {
      name: "get",
      description:
        'Full value of a node. ALWAYS get the target immediately before editing and quote "old" from the EXACT text returned. Use maxDepth to bound large subtrees.',
      schema: { type: "object", properties: { path: str, maxDepth: int }, required: ["path"] },
    },
    {
      name: "edit",
      description:
        'THE default write: replace an exact substring inside a string value. Never rewrite a whole block for a small change. "old" must occur exactly once — on an ambiguity error, re-quote a larger unique fragment or set replaceAll.',
      schema: {
        type: "object",
        properties: { path: str, old: str, new: str, replaceAll: bool },
        required: ["path", "old", "new"],
      },
    },
    {
      name: "set_value",
      description:
        "Replace a node's entire value. Expensive and rarely needed — prefer edit for changes inside existing content.",
      schema: {
        type: "object",
        // bare-schema property ({} = "any JSON") with a description so stricter
        // OpenAPI-subset converters and the model both get a hint
        properties: { path: str, value: { description: "The new value — any JSON" } },
        required: ["path", "value"],
      },
    },
    {
      name: "history",
      description: "Recent mutation events for a node (who changed what, before/after).",
      schema: { type: "object", properties: { path: str, limit: int }, required: [] },
    },
    {
      name: "get_at",
      description: "Value of a node as of a past version (event-log seq). Read-only time travel.",
      schema: { type: "object", properties: { path: str, version: int }, required: ["path", "version"] },
    },
    {
      name: "revert",
      description:
        "Restore a node to its value at a past version, as a NEW change (history is append-only — nothing is lost). Use get_at first to confirm the target state.",
      schema: { type: "object", properties: { path: str, version: int }, required: ["path", "version"] },
    },
  ];
}

const TOOL_NAMES: readonly AgentToolName[] = [
  "search",
  "find",
  "describe",
  "get",
  "edit",
  "set_value",
  "history",
  "get_at",
  "revert",
];

/** The ready-made tool definitions, freshly built on each call (safe to mutate).
 *  `include` filters to a subset, preserving the canonical order above. */
export function agentToolDefs(opts: { include?: AgentToolName[] } = {}): AgentToolDef[] {
  const defs = makeDefs();
  if (opts.include === undefined) return defs;
  const wanted = new Set<string>(opts.include);
  return defs.filter((d) => wanted.has(d.name));
}

/** Validation failure inside the executor — mapped to INVALID_INPUT, never thrown out. */
class InputError extends Error {}

function requireString(input: Record<string, unknown>, field: string): string {
  const v = input[field];
  if (typeof v !== "string") throw new InputError(`field "${field}" must be a string (required)`);
  return v;
}

function optionalString(input: Record<string, unknown>, field: string): string | undefined {
  const v = input[field];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new InputError(`field "${field}" must be a string`);
  return v;
}

function requireInt(input: Record<string, unknown>, field: string): number {
  const v = input[field];
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new InputError(`field "${field}" must be an integer (required)`);
  }
  return v;
}

function optionalInt(input: Record<string, unknown>, field: string): number | undefined {
  const v = input[field];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v)) throw new InputError(`field "${field}" must be an integer`);
  return v;
}

function optionalBool(input: Record<string, unknown>, field: string): boolean | undefined {
  const v = input[field];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new InputError(`field "${field}" must be a boolean`);
  return v;
}

type Dispatch = (ts: Toolset) => Promise<ToolResult<unknown>>;

/** Validate `inp` for `toolName` and return the dispatch thunk. Throws InputError only. */
function plan(toolName: AgentToolName, inp: Record<string, unknown>): Dispatch {
  switch (toolName) {
    case "search": {
      const query = requireString(inp, "query");
      const k = optionalInt(inp, "k");
      return (ts) => ts.search(query, { k });
    }
    case "find": {
      const pathPattern = optionalString(inp, "pathPattern");
      const type = optionalString(inp, "type");
      const tag = optionalString(inp, "tag");
      const limit = optionalInt(inp, "limit");
      return (ts) => ts.find({ pathPattern, type, tag }, { limit });
    }
    case "describe": {
      const path = optionalString(inp, "path");
      return (ts) => ts.describe(path === undefined ? undefined : { path });
    }
    case "get": {
      const path = requireString(inp, "path");
      const maxDepth = optionalInt(inp, "maxDepth");
      return (ts) => ts.get({ path }, { maxDepth });
    }
    case "edit": {
      const path = requireString(inp, "path");
      const oldStr = requireString(inp, "old");
      const newStr = requireString(inp, "new");
      const replaceAll = optionalBool(inp, "replaceAll");
      return (ts) => ts.patch({ path }, { op: "edit", old: oldStr, new: newStr, replaceAll });
    }
    case "set_value": {
      const path = requireString(inp, "path");
      if (!("value" in inp)) throw new InputError(`field "value" is required`);
      const value = inp["value"] as Json;
      return (ts) => ts.patch({ path }, { op: "set", value });
    }
    case "history": {
      const path = optionalString(inp, "path");
      const limit = optionalInt(inp, "limit");
      return (ts) => ts.history(path === undefined ? undefined : { path }, { limit });
    }
    case "get_at": {
      const path = requireString(inp, "path");
      const version = requireInt(inp, "version");
      return (ts) => ts.getAt({ path }, version);
    }
    case "revert": {
      const path = requireString(inp, "path");
      const version = requireInt(inp, "version");
      return (ts) => ts.revert({ path }, version);
    }
  }
}

function errorResult(code: string, message: string): string {
  return JSON.stringify({ ok: false, error: { code, message } });
}

/** A never-throw (toolName, input) → JSON-string executor over a Toolset — hand the
 *  returned function to your agent's tool-call loop. Errors come back serialized:
 *  UNKNOWN_TOOL, INVALID_INPUT, the guard's own refusal, TOO_LARGE (ok results over
 *  `maxResultChars`, default DEFAULT_MAX_RESULT_CHARS), or EXECUTOR_ERROR (catch-all). */
export function makeToolExecutor(
  toolset: Toolset,
  opts: { maxResultChars?: number; guard?: ToolGuard } = {},
): (toolName: string, input: unknown) => Promise<string> {
  const cap = opts.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  return async (toolName, input) => {
    if (!(TOOL_NAMES as readonly string[]).includes(toolName)) {
      return errorResult("UNKNOWN_TOOL", `unknown tool ${toolName}; available: ${TOOL_NAMES.join(", ")}`);
    }
    const name = toolName as AgentToolName;
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return errorResult("INVALID_INPUT", `input for ${name} must be a JSON object`);
    }
    const inp = input as Record<string, unknown>;
    let result: ToolResult<unknown>;
    try {
      const dispatch = plan(name, inp);
      // `!= null` so a plain-JS guard that returns undefined on its allow path
      // allows (only a real refusal object refuses); a malformed truthy return
      // is normalized so the agent always sees a well-formed ToolResult error.
      const refusal = opts.guard !== undefined ? opts.guard(name, inp) : null;
      if (refusal != null) {
        const wellFormed =
          typeof refusal === "object" &&
          typeof (refusal as { code?: unknown }).code === "string" &&
          typeof (refusal as { message?: unknown }).message === "string"
            ? refusal
            : { code: "GUARD_REFUSED", message: String(refusal) };
        return JSON.stringify({ ok: false, error: wellFormed });
      }
      result = await dispatch(toolset);
    } catch (err) {
      if (err instanceof InputError) return errorResult("INVALID_INPUT", err.message);
      return errorResult("EXECUTOR_ERROR", err instanceof Error ? err.message : String(err));
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
