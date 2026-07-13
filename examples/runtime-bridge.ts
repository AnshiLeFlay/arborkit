/**
 * A provider-neutral LLM tool loop over ArborKit. The same definitions can be
 * bound by LangChain/LangGraph; Anthropic needs only `schema -> input_schema`.
 *
 * Run with: npm run example:bridge
 */
import { agentToolDefs, makeToolExecutor, type AgentToolName } from "../src/agent-tools";
import { createArbor } from "../src/arbor";
import { sizeBasedDecision } from "../src/decompose";

const enabled: AgentToolName[] = ["get", "edit", "history"];
const arbor = createArbor({
  initial: { documents: { brief: "ArborKit keeps shared agent state in a JSON tree." } },
  decompose: sizeBasedDecision(1),
});
const toolset = arbor.toolset({
  owner: "editor-agent",
  readScope: "/documents",
  writeScope: "/documents",
});

const definitions = agentToolDefs({ include: enabled });
const execute = makeToolExecutor(toolset, { include: enabled });

// LangChain/LangGraph chat models accept ArborKit's {name, description, schema}
// definitions directly through model.bindTools(definitions).
const langChainDefinitions = definitions;

// Anthropic uses the same data with one field renamed.
const anthropicDefinitions = definitions.map(({ name, description, schema }) => ({
  name,
  description,
  input_schema: schema,
}));

// A real runtime supplies these calls from its model response. Keeping execution
// separate from model SDKs makes scopes, guards, and error semantics portable.
const modelToolCalls = [
  { name: "get", input: { path: "/documents/brief" } },
  {
    name: "edit",
    input: {
      path: "/documents/brief",
      old: "shared agent state",
      new: "shared, versioned agent state",
    },
  },
  { name: "history", input: { path: "/documents/brief", limit: 5 } },
];

for (const call of modelToolCalls) {
  const result = JSON.parse(await execute(call.name, call.input)) as { ok: boolean };
  if (!result.ok) throw new Error(`tool ${call.name} failed: ${JSON.stringify(result)}`);
  console.log(`${call.name}:`, JSON.stringify(result));
}

console.log("LangChain/LangGraph definitions:", langChainDefinitions.length);
console.log("Anthropic definitions:", anthropicDefinitions.length);
console.log("final document:", JSON.stringify(arbor.tree.toJson(), null, 2));

