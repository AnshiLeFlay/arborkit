# Getting started

ArborKit is a versioned, searchable JSON workspace for AI agents. It is an
embedded state layer, not an agent runtime: use your preferred model SDK or
orchestrator and give its agents scoped ArborKit tools.

## Requirements

- Node.js 20.6 or newer
- ESM

```bash
npm install arborkit
```

## Create a shared artifact

```ts
import { createArbor, sizeBasedDecision } from "arborkit";

const arbor = createArbor({
  initial: { plan: "", drafts: {} },
  decompose: sizeBasedDecision(1),
});

const writer = arbor.toolset({
  owner: "writer",
  readScope: "",
  writeScope: "/drafts",
});

const inserted = await writer.patch(
  { path: "/drafts" },
  { op: "insert", key: "intro", value: "First draft" },
);

if (!inserted.ok) throw new Error(inserted.error.message);
console.log(inserted.value); // { id, path: "/drafts/intro", version }
```

Every tool call returns a structured result. Expected agent errors such as a
scope violation or stale version do not escape the tool boundary as exceptions.

## Give the tools to an LLM

```ts
import { agentToolDefs, makeToolExecutor } from "arborkit";

const definitions = agentToolDefs({ include: ["get", "edit", "history"] });
const execute = makeToolExecutor(writer, {
  include: ["get", "edit", "history"],
});

// Bind `definitions` to the model, then dispatch each returned tool call:
const resultJson = await execute("edit", {
  path: "/drafts/intro",
  old: "First",
  new: "Reviewed",
});
```

Pass the same `include` list to the definitions and executor. This keeps the
advertised and executable capabilities identical.

## Choose the next guide

- [Decision guide](decision-guide.md) — fit, tradeoffs, and alternatives.
- [Architecture](architecture.md) — components and invariants.
- [Runtime integrations](integrations.md) — LangChain/LangGraph, Anthropic, and Mastra patterns.
- [Production checklist](production-checklist.md) — current operational boundaries.
- Run all repository examples with `npm run example:all`.
- Generate the complete API site with `npm run docs:api` and open `docs/api/index.html`.

