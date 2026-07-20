import {
  agentToolDefs,
  analyzeToolDefs,
  makeAnalyzeExecutor,
  makeToolExecutor,
  type AgentToolName,
  type AgentToolProfile,
  type AnalyzeToolName,
  type AnalyzeToolSurfaceOptions,
  type Arbor,
  type DurableArborSession,
  type ToolApproval,
  type ToolGuard,
  type ToolResult,
  type ToolsetBinding,
} from "arborkit";
import { ArborError, durableRequestHash } from "arborkit";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";

const JSON_MIME = "application/json";
const RESOURCE_NOT_FOUND = -32002;
const WRITE_TOOLS = new Set<AgentToolName>([
  "edit",
  "set_value",
  "insert",
  "remove",
  "move",
  "batch_patch",
  "revert",
]);

export interface ArborMcpResourceOptions {
  /** Maximum reconstructed subtree depth. Default 4. */
  maxDepth?: number;
  /** Maximum returned history events. Default 100. */
  historyLimit?: number;
  /** Maximum serialized resource size in UTF-16 code units. Default 100,000. */
  maxResultChars?: number;
}

export interface ArborMcpServerOptions {
  arbor?: Arbor;
  session?: DurableArborSession;
  artifactId: string;
  binding?: ToolsetBinding;
  /** Safe by default: mutation tools require an explicit editor/admin profile. */
  profile?: AgentToolProfile;
  include?: AgentToolName[];
  guard?: ToolGuard;
  approval?: ToolApproval;
  maxResultChars?: number;
  /** Native analysis tools are opt-in to keep the default tool surface small. */
  analysis?: boolean | AnalyzeToolSurfaceOptions;
  resources?: ArborMcpResourceOptions;
  serverInfo?: { name?: string; version?: string };
  /** Optional request-id mapping for durable idempotency. */
  idempotencyKey?: (toolName: string, input: Record<string, unknown>) => string | undefined | Promise<string | undefined>;
}

export interface NormalizedArborMcpOptions extends ArborMcpServerOptions {
  artifactId: string;
  profile: AgentToolProfile;
  resources: Required<ArborMcpResourceOptions>;
}

function currentArbor(options: ArborMcpServerOptions): Arbor {
  const arbor = options.session?.arbor ?? options.arbor;
  if (!arbor) throw new TypeError("exactly one of arbor or session is required");
  return arbor;
}

function requirePositiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

/** URI authorities are case-insensitive, so the canonical MCP artifact id is lowercase. */
export function normalizeArborMcpOptions(options: ArborMcpServerOptions): NormalizedArborMcpOptions {
  if ((options.arbor === undefined) === (options.session === undefined)) {
    throw new TypeError("exactly one of arbor or session is required");
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(options.artifactId)) {
    throw new TypeError("artifactId must be a URL-safe identifier using letters, digits, '.', '_' or '-'");
  }
  return {
    ...options,
    artifactId: options.artifactId.toLowerCase(),
    profile: options.profile ?? "reader",
    resources: {
      maxDepth: requirePositiveInteger(options.resources?.maxDepth, 4, "resources.maxDepth"),
      historyLimit: requirePositiveInteger(options.resources?.historyLimit, 100, "resources.historyLimit"),
      maxResultChars: requirePositiveInteger(options.resources?.maxResultChars, 100_000, "resources.maxResultChars"),
    },
  };
}

function annotations(name: string, isAnalysis: boolean): ToolAnnotations {
  const write = !isAnalysis && WRITE_TOOLS.has(name as AgentToolName);
  return {
    title: name.replaceAll("_", " "),
    readOnlyHint: !write,
    destructiveHint: write,
    idempotentHint: !write,
    openWorldHint: false,
  };
}

function asOutputSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return schema === undefined ? undefined : { type: "object", ...schema };
}

function executorResult(serialized: string) {
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(serialized);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
    parsed = value as Record<string, unknown>;
  } catch {
    parsed = { ok: false, error: { code: "INVALID_EXECUTOR_RESULT", message: "executor returned invalid JSON" } };
    serialized = JSON.stringify(parsed);
  }
  return {
    content: [{ type: "text" as const, text: serialized }],
    structuredContent: parsed,
    isError: parsed.ok !== true,
  };
}

function resourceNotFound(): never {
  throw new McpError(RESOURCE_NOT_FOUND, "resource not found");
}

function unwrap<T>(result: ToolResult<T>, hideScope = false): T {
  if (result.ok) return result.value;
  if (hideScope && (result.error.code === "SCOPE_VIOLATION" || result.error.code === "NODE_NOT_FOUND")) {
    return resourceNotFound();
  }
  throw new McpError(ErrorCode.InvalidParams, result.error.message, { code: result.error.code });
}

function jsonResource(uri: string, value: unknown, maxChars: number, hint: string) {
  const text = JSON.stringify(value);
  if (text.length > maxChars) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `resource is ${text.length} chars (cap ${maxChars}); ${hint}`,
      { code: "TOO_LARGE" },
    );
  }
  return { contents: [{ uri, mimeType: JSON_MIME, text }] };
}

/** Create one protocol server. HTTP stateless mode creates one instance per request. */
export function createArborMcpServer(input: ArborMcpServerOptions): Server {
  const options = normalizeArborMcpOptions(input);
  const baseUri = `arborkit://${options.artifactId}`;
  const stateDefs = agentToolDefs({ profile: options.profile, include: options.include });
  const stateNames = new Set<string>(stateDefs.map((definition) => definition.name));

  const analysisOptions = options.analysis === true ? {} : options.analysis || undefined;
  const analysisDefs = analysisOptions === undefined
    ? []
    : analyzeToolDefs({ profile: options.profile, include: analysisOptions.include });
  const analysisNames = new Set<string>(analysisDefs.map((definition) => definition.name));

  const server = new Server(
    {
      name: options.serverInfo?.name ?? "arborkit-mcp",
      version: options.serverInfo?.version ?? "1.6.0-alpha.1",
    },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        `ArborKit artifact '${options.artifactId}'. Read before writing, pass ifVersion for optimistic concurrency, ` +
        "and use batch_patch when related mutations must commit atomically.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...stateDefs, ...analysisDefs].map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.schema as { type: "object"; properties?: Record<string, object>; required?: string[] },
      outputSchema: asOutputSchema(definition.outputSchema) as
        | { type: "object"; properties?: Record<string, object>; required?: string[] }
        | undefined,
      annotations: annotations(definition.name, analysisNames.has(definition.name)),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    if (stateNames.has(name)) {
      const execute = (arbor: Arbor) => makeToolExecutor(arbor.toolset(options.binding), {
        profile: options.profile,
        include: options.include,
        guard: options.guard,
        approval: options.approval,
        maxResultChars: options.maxResultChars,
      })(name, args);
      if (options.session && WRITE_TOOLS.has(name as AgentToolName)) {
        try {
          const idempotencyKey = await options.idempotencyKey?.(name, args);
          const requestHash = idempotencyKey === undefined
            ? undefined
            : durableRequestHash({ tool: name, input: args } as never);
          const committed = await options.session.transact(
            { idempotencyKey, requestHash },
            async (arbor) => JSON.parse(await execute(arbor)) as Record<string, unknown>,
          );
          return executorResult(JSON.stringify(committed.value));
        } catch (error) {
          const result = error instanceof ArborError
            ? { ok: false, error: { code: error.code, message: error.message } }
            : { ok: false, error: { code: "EXECUTOR_ERROR", message: error instanceof Error ? error.message : String(error) } };
          return executorResult(JSON.stringify(result));
        }
      }
      return executorResult(await execute(currentArbor(options)));
    }
    if (analysisNames.has(name) && analysisOptions !== undefined) {
      const executeAnalysis = makeAnalyzeExecutor(currentArbor(options), {
        profile: options.profile,
        include: analysisOptions.include,
        readScope: options.binding?.readScope,
        maxResultChars: options.maxResultChars,
      });
      return executorResult(await executeAnalysis(name as AnalyzeToolName, args));
    }
    throw new McpError(ErrorCode.InvalidParams, `unknown tool ${name}`);
  });

  const fixedResources = [
    { uri: `${baseUri}/tree`, name: "ArborKit tree", description: "Scoped artifact tree", mimeType: JSON_MIME },
    { uri: `${baseUri}/history`, name: "ArborKit history", description: "Scoped mutation history", mimeType: JSON_MIME },
    { uri: `${baseUri}/version`, name: "ArborKit version", description: "Artifact version metadata", mimeType: JSON_MIME },
    { uri: `${baseUri}/types`, name: "ArborKit types", description: "Registered schema/type metadata", mimeType: JSON_MIME },
  ];

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: fixedResources }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      {
        uriTemplate: `${baseUri}/node/{nodeId}`,
        name: "ArborKit subtree",
        description: "Scoped subtree addressed by stable node id",
        mimeType: JSON_MIME,
      },
      {
        uriTemplate: `${baseUri}/history/{nodeId}`,
        name: "ArborKit node history",
        description: "Mutation history for one scoped node",
        mimeType: JSON_MIME,
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      return resourceNotFound();
    }
    if (parsed.protocol !== "arborkit:" || parsed.hostname !== options.artifactId || parsed.search || parsed.hash) {
      return resourceNotFound();
    }
    const path = parsed.pathname;
    if (path === "/tree") {
      const toolset = currentArbor(options).toolset(options.binding);
      const value = unwrap(
        await toolset.get({ path: options.binding?.readScope ?? "" }, { maxDepth: options.resources.maxDepth }),
      );
      return jsonResource(uri, value, options.resources.maxResultChars, "request a smaller node resource");
    }
    if (path === "/history") {
      const toolset = currentArbor(options).toolset(options.binding);
      const value = unwrap(await toolset.history(undefined, { limit: options.resources.historyLimit }));
      return jsonResource(uri, value, options.resources.maxResultChars, "reduce resources.historyLimit");
    }
    if (path === "/version") {
      return jsonResource(
        uri,
        {
          artifactId: options.artifactId,
          version: currentArbor(options).log.length(),
          historyBaseVersion: currentArbor(options).log.baseSeqValue(),
          retainedEvents: currentArbor(options).log.entries().length,
        },
        options.resources.maxResultChars,
        "increase resources.maxResultChars",
      );
    }
    if (path === "/types") {
      return jsonResource(
        uri,
        { types: currentArbor(options).registry?.list() ?? [] },
        options.resources.maxResultChars,
        "reduce registered JSON Schema metadata",
      );
    }

    const nodeMatch = /^\/node\/([^/]+)$/.exec(path);
    if (nodeMatch) {
      const toolset = currentArbor(options).toolset(options.binding);
      let id: string;
      try {
        id = decodeURIComponent(nodeMatch[1]);
      } catch {
        return resourceNotFound();
      }
      const value = unwrap(
        await toolset.get({ id }, { maxDepth: options.resources.maxDepth }),
        true,
      );
      return jsonResource(uri, value, options.resources.maxResultChars, "request a smaller descendant node");
    }

    const historyMatch = /^\/history\/([^/]+)$/.exec(path);
    if (historyMatch) {
      const toolset = currentArbor(options).toolset(options.binding);
      let id: string;
      try {
        id = decodeURIComponent(historyMatch[1]);
      } catch {
        return resourceNotFound();
      }
      const value = unwrap(
        await toolset.history({ id }, { limit: options.resources.historyLimit }),
        true,
      );
      return jsonResource(uri, value, options.resources.maxResultChars, "reduce resources.historyLimit");
    }
    return resourceNotFound();
  });

  return server;
}
