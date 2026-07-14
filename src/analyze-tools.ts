import type { Arbor } from "./arbor";
import type { AgentToolDef, AgentToolProfile, ToolRefusal } from "./agent-tools";
import { DEFAULT_MAX_RESULT_CHARS } from "./agent-tools";
import {
  collectVectors,
  kmeans,
  localOutlierScores,
  outlierScores,
  silhouette,
  type CollectVectorOptions,
  type LabeledVector,
} from "./analyze";
import { connectedComponents, knnGraph } from "./analyze-graph";
import { structuralHash } from "./analyze-struct";
import { isWithin } from "./jsonpointer";

// Code-unit string order: localeCompare depends on the process ICU locale and
// would break identical-input ⇒ identical-output across machines.
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export type AnalyzeToolName =
  | "cluster"
  | "outliers"
  | "local_outliers"
  | "silhouette"
  | "similarity_graph"
  | "components"
  | "structural_groups";

export type AnalyzeToolDef = AgentToolDef<AnalyzeToolName>;

const ANALYZE_TOOL_NAMES: readonly AnalyzeToolName[] = Object.freeze([
  "cluster",
  "outliers",
  "local_outliers",
  "silhouette",
  "similarity_graph",
  "components",
  "structural_groups",
]);

/** Every analysis capability is read-only, so all Agent Bridge profiles share it. */
export const ANALYZE_TOOL_PROFILES: Readonly<Record<AgentToolProfile, readonly AnalyzeToolName[]>> = Object.freeze({
  reader: ANALYZE_TOOL_NAMES,
  editor: ANALYZE_TOOL_NAMES,
  admin: ANALYZE_TOOL_NAMES,
});

export interface AnalyzeToolSurfaceOptions {
  profile?: AgentToolProfile;
  include?: AnalyzeToolName[];
}

export type AnalyzeToolGuard = (
  toolName: AnalyzeToolName,
  input: Record<string, unknown>,
) => ToolRefusal | null | undefined | Promise<ToolRefusal | null | undefined>;

export interface AnalyzeExecutorOptions extends AnalyzeToolSurfaceOptions {
  maxResultChars?: number;
  guard?: AnalyzeToolGuard;
  /** Optional JSON Pointer boundary applied to every vector and structural read. */
  readScope?: string;
}

const str = Object.freeze({ type: "string" } as const);
const positiveInt = Object.freeze({ type: "integer", minimum: 1 } as const);
const integer = Object.freeze({ type: "integer" } as const);
const number = Object.freeze({ type: "number" } as const);
const freshness = Object.freeze({ type: "string", enum: ["best-effort", "wait"] } as const);

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function resultSchema(value: Record<string, unknown>): Record<string, unknown> {
  return {
    oneOf: [
      objectSchema({ ok: { const: true }, value }, ["ok", "value"]),
      objectSchema({
        ok: { const: false },
        error: objectSchema({ code: str, message: str }, ["code", "message"]),
      }, ["ok", "error"]),
    ],
  };
}

function vectorProperties(): Record<string, unknown> {
  return { under: str, type: str, tag: str, freshness };
}

function makeDefs(): AnalyzeToolDef[] {
  return [
    {
      name: "cluster",
      description: "Deterministic seeded k-means over indexed nodes. Returns assignments, centroids, and inertia without a quality verdict.",
      schema: objectSchema({ ...vectorProperties(), k: positiveInt, seed: integer, maxIters: positiveInt }, ["k"]),
      outputSchema: resultSchema({ description: "K-means metrics and id/path-addressable assignments" }),
    },
    {
      name: "outliers",
      description: "Global-centroid distance scores, sorted descending. Higher means farther from the reference; no threshold is applied.",
      schema: objectSchema({ ...vectorProperties(), topN: positiveInt }),
      outputSchema: resultSchema({ type: "array", description: "Per-node distance scores" }),
    },
    {
      name: "local_outliers",
      description: "Mean distance to k nearest neighbours, sorted descending. Useful for multi-cluster data; no threshold is applied.",
      schema: objectSchema({ ...vectorProperties(), k: positiveInt, topN: positiveInt }),
      outputSchema: resultSchema({ type: "array", description: "Per-node local distance scores" }),
    },
    {
      name: "silhouette",
      description: "Cluster with deterministic k-means and return per-node plus mean silhouette in [-1,1].",
      schema: objectSchema({ ...vectorProperties(), k: positiveInt, seed: integer, maxIters: positiveInt }, ["k"]),
      outputSchema: resultSchema({ description: "Silhouette metrics and cluster assignments" }),
    },
    {
      name: "similarity_graph",
      description: "Build an undirected k-nearest-neighbour cosine-similarity graph over indexed nodes.",
      schema: objectSchema({ ...vectorProperties(), k: positiveInt, minWeight: number }, ["k"]),
      outputSchema: resultSchema({ description: "Similarity graph nodes and weighted edges" }),
    },
    {
      name: "components",
      description: "Build a similarity graph and return its deterministic connected components.",
      schema: objectSchema({ ...vectorProperties(), k: positiveInt, minWeight: number }, ["k"]),
      outputSchema: resultSchema({ description: "Similarity graph plus connected components" }),
    },
    {
      name: "structural_groups",
      description: "Group comparable subtrees by exact canonical JSON hash. With type, scans matching nodes; otherwise compares direct children under a path. relativePath selects the same descendant inside every candidate.",
      schema: objectSchema({ under: str, type: str, tag: str, relativePath: str }),
      outputSchema: resultSchema({ description: "Exact-hash groups plus candidates missing the selected relative path" }),
    },
  ];
}

function allowedNames(opts: AnalyzeToolSurfaceOptions): readonly AnalyzeToolName[] {
  const profile = opts.profile ?? "reader";
  const requested = opts.include === undefined ? undefined : new Set(opts.include);
  return ANALYZE_TOOL_NAMES.filter((name) =>
    ANALYZE_TOOL_PROFILES[profile].includes(name) && (requested === undefined || requested.has(name)),
  );
}

/** Fresh provider-neutral analysis definitions in canonical order. */
export function analyzeToolDefs(opts: AnalyzeToolSurfaceOptions = {}): AnalyzeToolDef[] {
  const allowed = new Set(allowedNames(opts));
  return makeDefs().filter((definition) => allowed.has(definition.name));
}

class InputError extends Error {}

class ScopeError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new InputError(`field "${field}" must be a string`);
  return value;
}

function optionalInteger(input: Record<string, unknown>, field: string): number | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new InputError(`field "${field}" must be an integer`);
  }
  return value;
}

function positiveInteger(
  input: Record<string, unknown>,
  field: string,
  opts: { required?: boolean; fallback?: number } = {},
): number | undefined {
  const value = optionalInteger(input, field) ?? opts.fallback;
  if (value === undefined) {
    if (opts.required) throw new InputError(`field "${field}" must be a positive integer (required)`);
    return undefined;
  }
  if (value <= 0) throw new InputError(`field "${field}" must be a positive integer`);
  return value;
}

function optionalNumber(input: Record<string, unknown>, field: string): number | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InputError(`field "${field}" must be a finite number`);
  }
  return value;
}

function scopedUnder(input: Record<string, unknown>, readScope?: string): string | undefined {
  const requested = optionalString(input, "under");
  if (readScope === undefined) return requested;
  if (requested === undefined) return readScope;
  if (!isWithin(requested, readScope)) {
    throw new ScopeError(`path ${requested} is outside read scope ${readScope}`);
  }
  return requested;
}

function vectorOptions(input: Record<string, unknown>, readScope?: string): CollectVectorOptions {
  const freshnessValue = input["freshness"];
  if (freshnessValue !== undefined && freshnessValue !== "best-effort" && freshnessValue !== "wait") {
    throw new InputError('field "freshness" must be "best-effort" or "wait"');
  }
  return {
    under: scopedUnder(input, readScope),
    type: optionalString(input, "type"),
    tag: optionalString(input, "tag"),
    freshness: freshnessValue as CollectVectorOptions["freshness"],
  };
}

function withPaths(view: LabeledVector[], scores: Array<{ id: string; score: number }>) {
  const byId = new Map(view.map((item) => [item.id, item]));
  return scores.map((score) => ({
    ...score,
    path: byId.get(score.id)?.path,
    type: byId.get(score.id)?.type,
  }));
}

type Dispatch = () => Promise<unknown>;

function vectorPlan(
  arbor: Arbor,
  name: Exclude<AnalyzeToolName, "structural_groups">,
  input: Record<string, unknown>,
  readScope?: string,
): Dispatch {
  const filters = vectorOptions(input, readScope);
  const collect = () => collectVectors(arbor, filters);
  switch (name) {
    case "cluster": {
      const k = positiveInteger(input, "k", { required: true })!;
      const seed = optionalInteger(input, "seed");
      const maxIters = positiveInteger(input, "maxIters");
      return async () => {
        const view = await collect();
        const result = kmeans(view, { k, seed, maxIters });
        return {
          ...result,
          assignments: view.map((item, index) => ({
            id: item.id,
            path: item.path,
            type: item.type,
            cluster: result.assignments[index],
          })),
        };
      };
    }
    case "outliers": {
      const topN = positiveInteger(input, "topN", { fallback: 10 })!;
      return async () => {
        const view = await collect();
        return withPaths(view, outlierScores(view))
          .sort((a, b) => b.score - a.score || byCodeUnit(a.id, b.id))
          .slice(0, topN);
      };
    }
    case "local_outliers": {
      const k = positiveInteger(input, "k");
      const topN = positiveInteger(input, "topN", { fallback: 10 })!;
      return async () => {
        const view = await collect();
        return withPaths(view, localOutlierScores(view, { k }))
          .sort((a, b) => b.score - a.score || byCodeUnit(a.id, b.id))
          .slice(0, topN);
      };
    }
    case "silhouette": {
      const k = positiveInteger(input, "k", { required: true })!;
      const seed = optionalInteger(input, "seed");
      const maxIters = positiveInteger(input, "maxIters");
      return async () => {
        const view = await collect();
        const clustered = kmeans(view, { k, seed, maxIters });
        const quality = silhouette(view, clustered.assignments);
        return {
          k: clustered.k,
          mean: quality.mean,
          inertia: clustered.inertia,
          perItem: withPaths(view, quality.perItem).map((item, index) => ({
            ...item,
            cluster: clustered.assignments[index],
          })),
        };
      };
    }
    case "similarity_graph": {
      const k = positiveInteger(input, "k", { required: true })!;
      const minWeight = optionalNumber(input, "minWeight");
      return async () => knnGraph(await collect(), { k, minWeight });
    }
    case "components": {
      const k = positiveInteger(input, "k", { required: true })!;
      const minWeight = optionalNumber(input, "minWeight");
      return async () => {
        const graph = knnGraph(await collect(), { k, minWeight });
        return { ...graph, components: connectedComponents(graph.nodes, graph.edges) };
      };
    }
  }
}

function structuralPlan(arbor: Arbor, input: Record<string, unknown>, readScope?: string): Dispatch {
  const under = scopedUnder(input, readScope) ?? "";
  const type = optionalString(input, "type");
  const tag = optionalString(input, "tag");
  const relativePath = optionalString(input, "relativePath") ?? "";
  if (relativePath !== "" && !relativePath.startsWith("/")) {
    throw new InputError('field "relativePath" must be empty or start with "/"');
  }
  const parent = arbor.addressing.byPath(under);
  if (!parent) throw new InputError(`field "under" does not resolve to a node: ${under}`);
  return async () => {
    const candidates = type === undefined
      ? arbor.tree.children(parent.id)
      : arbor.tree.allNodes().filter((node) =>
          node.type === type && isWithin(arbor.addressing.pathOf(node.id), under),
        );
    const groups = new Map<string, Array<{ id: string; path: string }>>();
    const missing: string[] = [];
    for (const node of candidates) {
      if (tag !== undefined && !(node.tags?.includes(tag) ?? false)) continue;
      const basePath = arbor.addressing.pathOf(node.id);
      const selected = relativePath === "" ? node : arbor.addressing.byPath(basePath + relativePath);
      if (!selected) {
        missing.push(basePath);
        continue;
      }
      const hash = structuralHash(arbor.tree.toJson(selected.id));
      const members = groups.get(hash) ?? [];
      members.push({ id: node.id, path: basePath });
      groups.set(hash, members);
    }
    return {
      relativePath,
      missing: missing.sort(),
      groups: [...groups]
        .map(([hash, members]) => ({
          hash,
          ids: members.map((member) => member.id).sort(),
          paths: members.map((member) => member.path).sort(),
        }))
        .sort((a, b) => byCodeUnit(a.paths[0] ?? "", b.paths[0] ?? "") || byCodeUnit(a.hash, b.hash)),
    };
  };
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

/** Build a read-only, never-throw analysis executor compatible with Agent Bridge definitions. */
export function makeAnalyzeExecutor(
  arbor: Arbor,
  opts: AnalyzeExecutorOptions = {},
): (toolName: string, input: unknown) => Promise<string> {
  const allowed = allowedNames(opts);
  const cap = opts.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  return async (toolName, input) => {
    if (!(allowed as readonly string[]).includes(toolName)) {
      return errorResult(
        "UNKNOWN_TOOL",
        allowed.length === 0
          ? `unknown tool ${toolName}; no analysis tools are enabled`
          : `unknown tool ${toolName}; available: ${allowed.join(", ")}`,
      );
    }
    const name = toolName as AnalyzeToolName;
    if (!isPlainObject(input)) return errorResult("INVALID_INPUT", `input for ${name} must be a JSON object`);
    try {
      const dispatch = name === "structural_groups"
        ? structuralPlan(arbor, input, opts.readScope)
        : vectorPlan(arbor, name, input, opts.readScope);
      const refusal = opts.guard === undefined ? null : await opts.guard(name, input);
      if (refusal != null) return JSON.stringify({ ok: false, error: normalizeRefusal(refusal) });
      const serialized = JSON.stringify({ ok: true, value: await dispatch() });
      if (serialized.length > cap) {
        return errorResult(
          "TOO_LARGE",
          `result is ${serialized.length} chars (cap ${cap}) — narrow under/type/tag or reduce topN/k`,
        );
      }
      return serialized;
    } catch (error) {
      if (error instanceof ScopeError) return errorResult("SCOPE_VIOLATION", error.message);
      if (error instanceof InputError) return errorResult("INVALID_INPUT", error.message);
      return errorResult("EXECUTOR_ERROR", error instanceof Error ? error.message : String(error));
    }
  };
}
