# Arbor

A general-purpose TypeScript core for multi-agent systems built around one shared
**artifact tree**: agents navigate and edit a JSON tree through scoped tools, with a
per-node exact + semantic index, a reversible event log, snapshots, and time-travel.
**Zero runtime dependencies.**

## The stack

- **Tree** — decompose a JSON value into addressable nodes (stable ids + JSON-Pointer paths), reconstruct any subtree.
- **Mutations** — `set`/`insert`/`remove`/`move` with scope + optimistic-version guards, recorded in a reversible event log; atomic transactions.
- **Types** — optional per-type validation + decomposition override (`TypeRegistry`); a structural Zod adapter (zod is a dev-only dependency).
- **Navigate** — `describe`/`get`/`find` (by id, path, tag, or glob) — depth-bounded and paginated.
- **Semantic index** — per-node embeddings via pluggable `EmbeddingPort`/`VectorIndexPort`; `search` by meaning, off the mutation path (mutations only mark stale; an async reindexer embeds).
- **Storage** — serialize the whole artifact (tree + log + vectors) to memory or a JSON file; restore it intact.
- **Replay** — reconstruct any past version, `diff` two versions, `revert` a node (append-only, path-addressed).
- **Toolset** — `makeToolset(...)` hands an agent a scoped, async, structured-result bundle: `describe`/`get`/`find`/`search`/`patch`/`history`. Writes are confined to `writeScope`, reads to `readScope`; errors are returned, never thrown across the boundary.

## Quickstart

```ts
import { ArtifactTree } from "./src/artifact-tree";
import { Addressing } from "./src/addressing";
import { EventLog } from "./src/event-log";
import { Mutator } from "./src/mutator";
import { makeToolset } from "./src/toolset";
import { sizeBasedDecision } from "./src/decompose";
import { SeqIdGen } from "./src/ids";
import { SystemClock } from "./src/clock";

const deps = { idGen: new SeqIdGen(), clock: new SystemClock(), decision: sizeBasedDecision(1) };
const tree = ArtifactTree.fromJson({ pages: {} }, deps);
const addressing = new Addressing(tree);
const log = new EventLog();
const mutator = new Mutator(tree, addressing, log, { clock: deps.clock });

// Hand an agent a toolset scoped to /pages:
const tools = makeToolset({ tree, addressing, log, mutator }, { owner: "agent-1", writeScope: "/pages" });
const ins = await tools.patch({ path: "/pages" }, { op: "insert", key: "home", value: { title: "Home" } });
const home = await tools.get({ path: "/pages/home" });
// ins.ok === true; home.ok === true, home.value.content === { title: "Home" }
```

## Run the example

```bash
npm run example   # narrated end-to-end content-site scenario (examples/content-site.ts)
```

## Develop

```bash
npm test          # vitest
npm run typecheck # tsc --noEmit
```

## Docs

Design spec and milestone plans live in [`docs/superpowers/`](docs/superpowers/).

## Status

**v1 core complete (M1–M9):** tree, mutations + reversible log, optional types, exact navigation, semantic index, storage, replay/time-travel, scoped agent toolset, and the end-to-end scenario.

Deferred (post-v1): LangChain `tool()` / MCP-server adapters over the toolset; `getAt`/`revert` as toolset methods; DB-backed storage & vector adapters (SQLite/sqlite-vec, Postgres/pgvector); a CRDT backend.
