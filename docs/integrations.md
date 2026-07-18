# Runtime integrations

ArborKit owns artifact state and tool execution. The surrounding runtime owns
model calls, scheduling, retries, and the conversation/tool-call loop.

For clients that already speak MCP, prefer the separate `@arborkit/mcp` package
instead of writing the in-process wrappers below. See [MCP server](mcp.md).

## LangChain and LangGraph

`agentToolDefs()` returns `{ name, description, schema }` objects accepted by
LangChain chat models through `bindTools`. A LangGraph node can keep the Arbor
instance in application runtime context and dispatch returned calls through one
executor.

```ts
const definitions = agentToolDefs({ profile: "editor" });
const execute = makeToolExecutor(arbor.toolset({
  owner: "graph:editor",
  readScope: "/pages",
  writeScope: "/pages",
}), { profile: "editor" });

const modelWithTools = model.bindTools(definitions);
// In the graph node: await execute(toolCall.name, toolCall.args)
```

Keep ArborKit persistence separate from the LangGraph checkpointer: the
checkpointer resumes graph execution, while ArborKit versions the artifact being
produced.

## Anthropic SDK

Rename `schema` to `input_schema`, then use the same executor.

```ts
const tools = agentToolDefs().map(({ name, description, schema }) => ({
  name,
  description,
  input_schema: schema,
}));
```

## Mastra

Wrap each enabled operation in a Mastra custom tool. Let Mastra own the agent,
workflow, approvals, and observability; let the custom tool call ArborKit's
executor. Define the corresponding input schema in the Mastra tool so its runtime
can validate the arguments before dispatch.

```ts
const execute = makeToolExecutor(arbor.toolset({
  owner: "mastra:writer",
  readScope: "/drafts",
  writeScope: "/drafts",
}), { include: ["get", "edit"] });

// Inside a Mastra createTool({ id: "arbor_edit", ... }) executor:
const result = JSON.parse(await execute("edit", context));
if (!result.ok) return result; // preserve ArborKit's structured agent error
return result.value;
```

## Provider-neutral loop

The repository's runnable [runtime bridge example](../examples/runtime-bridge.ts)
demonstrates the definitions, Anthropic mapping, allowlisted executor, and tool
result round-trip without requiring a particular model SDK.

Read-only analysis definitions can be appended to the same provider tool list
and routed to a separate executor holding the full Arbor instance. See
[Native analysis](native-analysis.md#give-analysis-tools-to-an-agent) for the
composition pattern.

## Standard MCP clients

`@arborkit/mcp` exposes both tools and resources without a runtime-specific
adapter. Use stdio for a local child process (Claude Desktop/Code, Mastra), or
the stateless Streamable HTTP endpoint for server-side AI SDK and
LangChain/LangGraph clients. The MCP layer delegates to the same agent executor,
so profiles, `ifVersion`, guards, approvals, and atomic batches keep their core
semantics.
