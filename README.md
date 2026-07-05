# Arbor (`arborkit`)

A general-purpose TypeScript core for multi-agent systems built around one shared
**artifact tree**: agents navigate and edit a JSON tree through scoped tools, with a
per-node exact + semantic index, a reversible event log, snapshots + delta persistence,
and time-travel. **Zero runtime dependencies.**

```bash
npm install arborkit
```

ESM-only, Node ≥ 20.6.

## The stack

- **Tree** — decompose a JSON value into addressable nodes (stable ids + JSON-Pointer paths), reconstruct any subtree.
- **Mutations** — `set`/`insert`/`remove`/`move` with scope + optimistic-version guards, recorded in a reversible event log; atomic transactions.
- **Types** — optional per-type validation + decomposition override (`TypeRegistry`); a structural Zod adapter (zod is a dev-only dependency).
- **Navigate** — `describe`/`get`/`find` (by id, path, tag, or glob) — depth-bounded and paginated; `find` returns `{hits, truncated}` so truncation is never silent.
- **Semantic index** — per-node embeddings via pluggable `EmbeddingPort`/`VectorIndexPort` (async — DB-backed adapters welcome); `search` by meaning returns `{results, staleCount}`, off the mutation path (mutations only mark stale; an async reindexer embeds).
- **Storage** — serialize the whole artifact (tree + log + vectors) to memory or a JSON file; or persist incrementally (checkpoint + appendable NDJSON journal); restore intact either way.
- **Replay** — reconstruct any past version, `diff` two versions, `revert` a node (append-only, path-addressed).
- **Toolset** — hand an agent a scoped, async, structured-result bundle: `describe`/`get`/`find`/`search`/`patch`/`history`. Writes are confined to `writeScope`, reads to `readScope`; errors are returned, never thrown across the boundary. `patch` returns `{id, path, version}` of the touched node.
- **Facade** — `createArbor`/`restoreArbor` wire all of the above in one call.

## Quickstart

```ts
import { createArbor, restoreArbor, MockEmbeddingPort, MemoryDeltaStorage, sizeBasedDecision } from "arborkit";

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

// Semantic search — mutations only mark nodes stale; reindex() embeds:
await arbor.index!.reindex();
const found = await arbor.index!.search("home page"); // { results, staleCount }

// Incremental persistence — the first saveDelta() auto-checkpoints:
await arbor.saveDelta();

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

## Run the example

```bash
npm run example   # narrated end-to-end content-site scenario (examples/content-site.ts)
```

## Develop

```bash
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run build     # tsup → dist/ (ESM + type declarations)
```

Subpath imports work too: `import { Replay } from "arborkit/replay";` — every
module in `src/` maps onto `arborkit/<module>`.

## Docs

Design spec and milestone plans live in [`docs/superpowers/`](docs/superpowers/).

## Status

**v1 core complete (M1–M9), hardened (M10), packaged (M11), log compaction (M12), delta persistence (M13), hardening-2 (M14), API polish + facade (M15), published as arborkit (M16):** tree, mutations + reversible log, optional types, exact navigation, semantic index, storage, replay/time-travel, scoped agent toolset, end-to-end scenario, index-lifecycle hardening, and an installable ESM build.

Deferred (post-v1): LangChain `tool()` / MCP-server adapters over the toolset; `getAt`/`revert` as toolset methods; DB-backed storage & vector adapters (SQLite/sqlite-vec, Postgres/pgvector); a CRDT backend.
