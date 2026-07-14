# ArborKit (`arborkit`)

A **versioned, searchable JSON workspace for AI agents**. ArborKit gives agents
scoped tools to navigate and edit one shared artifact, while the application gets
stable node identity, exact + semantic discovery, an append-only audit log,
time-travel, and snapshot + delta persistence. **Zero runtime dependencies.**

ArborKit is an embedded artifact-state layer, not an agent runtime. Use it inside
LangGraph, Mastra, an SDK tool loop, or your own orchestrator.

```bash
npm install arborkit
```

ESM-only, Node ≥ 20.6.

## Is ArborKit a fit?

Use it when several agents incrementally build a structured artifact — a site,
research dossier, plan, report, catalog, or configuration — and you need narrow
write scopes, cheap exact edits, audit history, and reversible changes.

Choose another primary state layer when you need offline/realtime multi-writer
CRDT convergence, a shared database, or a durable workflow scheduler. ArborKit v1
is deliberately single-process and single-writer.

- [Start in 15 minutes](docs/getting-started.md)
- [Decision guide: ArborKit vs LangGraph, Mastra, Automerge, Yjs, and Liveblocks](docs/decision-guide.md)
- [Architecture and invariants](docs/architecture.md)
- [Agent bridge: tools, profiles, concurrency, and approvals](docs/agent-bridge.md)
- [Native analysis: clusters, outliers, structure, and graphs](docs/native-analysis.md)
- [Production checklist](docs/production-checklist.md)
- [Runtime integration patterns](docs/integrations.md)

```text
LLM SDK / agent runtime
          │ tool calls
          ▼
 scoped ArborKit toolset ──► artifact tree ──► snapshot / AG-UI state
          │                       │
          ├── exact + semantic    └──────────► append-only event log
          └── edit + time travel
```

## The stack

- **Tree** — decompose a JSON value into addressable nodes (stable ids + JSON-Pointer paths), reconstruct any subtree.
- **Mutations** — `set`/`insert`/`remove`/`move` with scope + optimistic-version guards, recorded in a reversible event log; atomic transactions.
- **Agent edits** — `patch {op: "edit", old, new}`: exact-substring surgery on a string leaf (Claude Code `Edit`-tool semantics — unique `old` or a structured failure with the occurrence count). Pure sugar over `set`, so history/revert/deltas need nothing new; the agent emits ~100 tokens of arguments instead of regenerating a whole block.
- **Types** — optional per-type validation + decomposition override (`TypeRegistry`); a structural Zod adapter (zod is a dev-only dependency).
- **Navigate** — `describe`/`get`/`find` (by id, path, tag, or glob) — depth-bounded and paginated; `find` returns `{hits, truncated}` so truncation is never silent.
- **Semantic index** — per-node embeddings via pluggable `EmbeddingPort`/`VectorIndexPort` (async — DB-backed adapters welcome); `search` by meaning returns `{results, staleCount}`, off the mutation path (mutations only mark stale; an async reindexer embeds).
- **Storage** — serialize the whole artifact (tree + log + vectors) to memory or a JSON file; or persist incrementally (checkpoint + appendable NDJSON journal); restore intact either way.
- **Replay** — reconstruct any past version, `diff` two versions, `revert` a node (append-only, path-addressed).
- **Toolset** — hand an agent a scoped, async, structured-result bundle: `describe`/`get`/`find`/`search`/`patch`/`batchPatch`/`history`/`getAt`/`revert`. `batchPatch` applies `set`/`insert`/`remove`/`move`/`edit` atomically and rolls the whole batch back on failure. Writes are confined to `writeScope`, reads to `readScope`; errors are returned, never thrown across the boundary.
- **Agent bridge** — 13 provider-neutral LLM tools with input + output JSON Schemas, `reader`/`editor`/`admin` profiles, optimistic `ifVersion`, atomic `batch_patch`, full semantic-search filters, operation-level guards, async approvals, and a never-throw executor. LangChain `bindTools` accepts the definitions as-is; Anthropic needs a one-line `input_schema` mapping.
- **Native analysis** — deterministic vector clustering/quality/outlier metrics, structural hashes and shape similarity, graph algorithms, and seven read-only LLM tools. Verdict-free by design: thresholds and domain labels stay in the application.
- **AG-UI adapter** — expose the tree + log as [AG-UI](https://docs.ag-ui.com) shared-state events: `snapshotEvent` (STATE_SNAPSHOT) + `deltaSince` (STATE_DELTA with RFC 6902 JSON Patch ops). Zero-dep — plain objects shaped like AG-UI events, no AG-UI SDK required.
- **Facade** — `createArbor`/`restoreArbor` wire all of the above in one call.

## Quickstart

```ts
import { createArbor, restoreArbor, MockEmbeddingPort, MemoryDeltaStorage, sizeBasedDecision, snapshotEvent, deltaSince, agentToolDefs, makeToolExecutor } from "arborkit";

const delta = new MemoryDeltaStorage();
const arbor = createArbor({
  initial: { pages: {}, plan: "" },
  decompose: sizeBasedDecision(1), // decompose aggressively so this tiny demo gets addressable nodes
  embedding: new MockEmbeddingPort(), // swap in a real EmbeddingPort (e.g. an API-backed one)
  delta,
});

// Hand an agent a scoped toolset — writes confined to /pages:
const tools = arbor.toolset({ owner: "writer", writeScope: "/pages", readScope: "/pages" });
const ins = await tools.patch({ path: "/pages" }, { op: "insert", key: "home", value: { title: "Home" } });
if (!ins.ok) throw new Error(ins.error.message); // ins.value === { id, path: "/pages/home", version }
const home = await tools.get({ path: "/pages/home" }); // home.value.content === { title: "Home" } (a clone)
const refused = await tools.patch({ path: "/plan" }, { op: "set", value: "hacked" });
// refused.ok === false — out of scope; violations are returned, never thrown

// Agent edits — surgical substring replacement instead of regenerating a block:
// get the node first, quote `old` from the live value (Claude Code Edit semantics).
await tools.patch({ path: "/pages/home" }, { op: "set", value: { title: "Home", html: "<p>Bonus: 100% do 2000 PLN</p>" } });
const edited = await tools.patch(
  { path: "/pages/home/html" },
  { op: "edit", old: "100% do 2000 PLN", new: "150% do 3000 PLN" },
); // unique-or-fail: an ambiguous `old` returns INVALID_OP with the occurrence count

// Or hand the whole toolset to an LLM — ready-made defs + a never-throw executor:
const defs = agentToolDefs({ profile: "editor" }); // LangChain bindTools accepts these as-is
// Anthropic SDK: defs.map((d) => ({ name: d.name, description: d.description, input_schema: d.schema }))
const exec = makeToolExecutor(tools, { profile: "editor" }); // opts: { guard, approval, maxResultChars }
const out = await exec("edit", {
  path: "/pages/home/html", old: "150% do 3000 PLN", new: "200% do 4000 PLN",
  ifVersion: edited.ok ? edited.value.version : undefined,
});
// out is always a JSON string of the ToolResult — errors come back serialized, never thrown

// Semantic search — mutations only mark nodes stale; reindex() embeds:
await arbor.index!.reindex();
const found = await arbor.index!.search("home page"); // { results, staleCount }

// Incremental persistence — the first saveDelta() auto-checkpoints:
await arbor.saveDelta();

// AG-UI shared-state stream — snapshot once, then RFC 6902 deltas per poll:
let cursor = arbor.log.length();
const snap = snapshotEvent(arbor.tree); // { type: "STATE_SNAPSHOT", snapshot }
// ...after more mutations:
const { event, nextSeq } = deltaSince(arbor.log, cursor); // { type: "STATE_DELTA", delta: [...] }
cursor = nextSeq; // throws below the compaction floor — re-send a fresh snapshot then

// Later (e.g. a new process): restore, then time-travel:
const restored = await restoreArbor({ decompose: sizeBasedDecision(1), embedding: new MockEmbeddingPort(), delta });
const past = restored!.replay.getAt("/pages/home", 0); // undefined — before the insert
```

## Lifecycle notes

- The first `saveDelta()` auto-checkpoints — a journal without a checkpoint is
  unrestorable, so the facade snapshots instead of appending.
- `checkpoint({ keepLast: N })` first compacts the event log to a sliding window of
  the last N events, then snapshots — this is the knob that bounds both memory and
  checkpoint size.
- Time-travel (`getAt`/`reconstructValueAt`/`revert`) below the compaction floor
  throws — that history is gone by design.
- `restoreArbor` MUST be given the same `decompose`/`registry` as the original run:
  journal-touched nodes are re-decomposed on delta restore, so a different policy
  would silently reshape the tree.

## Format compatibility

StoredArtifact **v1** files (written before compaction existed) still load; **v2**
adds `baseSeq` (the persisted compaction floor). Delta storage keeps a checkpoint
plus an NDJSON journal; a torn journal tail is isolated on restore.

## Scope & limits (read this before adopting)

- **Single process, single writer.** The tree lives in memory; storage is a snapshot
  target, not a database. There is no locking — two processes sharing one artifact
  file will clobber each other. One artifact = one run = one process.
- **Scoping is a guardrail, not a security boundary.** `writeScope`/`readScope`
  contain an agent's *tool calls* (including prompt-injected ones — a writer scoped
  to `/pages/home` has no path to `/secret`). They do NOT isolate *code*: every
  toolset shares the same heap, and anything holding the `Mutator` or tree can
  bypass scope. Do not run mutually-untrusted agent code in one process.
- **Log growth is bounded by opt-in compaction.** `EventLog.compactTo(floorSeq)` drops
  history before a floor — e.g. `log.compactTo(log.length() - N)` keeps a sliding window
  of the last N events, capping both memory and the serialized event payload (the floor
  is persisted as `baseSeq` and survives restore). Time-travel below the floor throws —
  that history is gone. Nothing auto-compacts; choose a policy (per run, sliding window,
  or never; `checkpoint({keepLast})` is the facade shortcut).
- **Saves can be incremental (opt-in delta persistence).** `DeltaStoragePort` (memory + file)
  splits persistence into a periodic full checkpoint and cheap event appends — a
  routine save costs O(new events) instead of rewriting the whole artifact. Restore loads
  the checkpoint and forward-replays the journal, preserving node types and the vectors of
  unchanged nodes (touched nodes are re-decomposed and left stale for reindex). A checkpoint
  still serializes the whole **tree** — delta-of-tree is future work; restore must use the
  same decompose decision as the original run.
- **Vector search is brute-force cosine** in the bundled `MemoryVectorIndex` — comfortable
  to ~10⁴ vectors; plug a real ANN store into the (async) `VectorIndexPort` beyond that.
- **Ops are id-anchored** (a useful property for a future CRDT backend), but there is
  **no CRDT**: no merge, no convergence, no multi-writer conflict resolution.
- **`ifVersion` on `insert` is parent-scoped:** it is a compare-and-set on the
  *container's* version, and every sibling insert bumps the container. Use it to
  guard "the container hasn't changed", not "my item is new".

## Run the examples

```bash
npm run example:content   # scoped agents build and edit a content site
npm run example:research  # researchers and a synthesizer share one artifact
npm run example:bridge    # provider-neutral LLM tool-call round-trip
npm run example:analysis  # read -> analyze -> fix with vector + structural metrics
npm run example:all       # run all four
```

## Develop

```bash
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run build     # tsup → dist/ (ESM + type declarations)
npm run bench     # micro-benchmarks (replay, navigation, glob find, vector search)
npm run docs:api  # TypeDoc → docs/api/index.html
```

Subpath imports work too: `import { Replay } from "arborkit/replay";` — every
module in `src/` maps onto `arborkit/<module>`.

## Docs

- [Getting started](docs/getting-started.md)
- [Decision guide](docs/decision-guide.md)
- [Architecture](docs/architecture.md)
- [Agent bridge](docs/agent-bridge.md)
- [Native analysis](docs/native-analysis.md)
- [Production checklist](docs/production-checklist.md)
- [Runtime integrations](docs/integrations.md)
- Full generated API reference: run `npm run docs:api`, then open
  `docs/api/index.html`.

Historical design specs and implementation plans live in
[`docs/superpowers/`](docs/superpowers/).

## Status

**v1.4 core complete through M21:** the original tree/mutation/index/storage/replay/toolset stack, the complete M20 agent bridge, and native verdict-free vector, structural, and graph analysis with a read-only LLM tool surface.

Deferred (post-v1): an MCP-server adapter over the toolset; DB-backed storage & vector adapters (SQLite/sqlite-vec, Postgres/pgvector); a CRDT backend.
