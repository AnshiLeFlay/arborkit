# Arbor — M9: Scenario & Example (v1 core capstone) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the whole Arbor stack holds together with a content-generator-shaped end-to-end scenario test, ship a runnable narrated `examples/` script, and add a concise README — closing the v1 core.

**Architecture:** No new library code — M9 wires the existing M1–M8 pieces into one realistic flow: a typed artifact (`TypeRegistry` + `typeAwareDecision` + `makeRegistryValidator`) with a semantic index, scaffolded by an admin via the `Mutator`, edited by per-page agents through scoped `makeToolset` bundles, searched by an editor, then persisted/restored and time-travelled. The scenario lives both as an asserted Vitest test (the CI-verified proof) and as a narrated runnable script (living docs). A short README documents the stack and a minimal wiring quickstart.

**Tech Stack:** Node ≥20.6, TypeScript (ESM, strict), Vitest. One new **devDependency**: `tsx` (to run the TS example; runtime deps stay zero). Builds on M1–M8.

---

## Scope of THIS plan (Milestone 9 — LAST of v1 core)

Covers the spec's scenario/example milestone: content-generator-shaped e2e fixtures + a runnable `examples/` script wiring the full stack, plus a README. Produces working, testable software: a single scenario exercising build → types/validation → scoped multi-agent writes → semantic search → persist/restore → time-travel, runnable as both a test and a script.

**Out of scope (post-v1):** LangChain `tool()` wrappers / MCP-server adapter over `Toolset`; `getAt`/`revert` as toolset methods; DB-backed `StoragePort`/`VectorIndexPort` (SQLite/pgvector); CRDT backend; building the actual SEO content-generator on Arbor (its own downstream project). These are listed in the README's Status, not implemented here.

## Design decisions (locked for M9)

1. **No new `src/` code.** M9 is integration + docs. If the scenario reveals a real bug, fix the owning module in a separate, clearly-scoped step — but the expectation is the stack already works (M1–M8 each shipped green).
2. **Pages are typed opaque leaves.** `PageContent` registers `decompose: "opaque"` (each page is one indexed unit, not split), `validate` (must be an object with a string `title`), and `embedText` (`"title body"`). This exercises the type-aware decomposition override, registry validation, and per-type embedding in one type.
3. **Admin scaffolds via `Mutator`; agents edit via scoped `makeToolset`.** Setting a node's `type`/`tags` is an orchestration concern done through the `Mutator` (the `PatchOp` surface intentionally has no `type` field). Per-page writers get a toolset bound to `writeScope: /site/pages/<slug>`; an editor gets `readScope: /site`. This mirrors the content-generator's `content-writer` concurrency=6, writeScope=/pages/<slug> pattern.
4. **Fixture threshold is `sizeBasedDecision(1)`.** Empty scaffolds (`{}` = 2 bytes) must stay navigable objects, not opaque leaves — the documented fixture gotcha. Pages override to `opaque` via their type regardless.
5. **Deterministic semantic assertions.** With the deterministic `MockEmbeddingPort`, a query equal to a page's exact `embedText` yields cosine ≈ 1, so it ranks first. The editor searches `"Pricing plans and cost"` (= `embedText` of the filled pricing page, `title:"Pricing"` + `body:"plans and cost"`).
6. **The example runs via `tsx`.** Extensionless ESM TS imports need a TS-aware loader; `tsx` is the standard, added as a devDependency with an `npm run example` script. `examples/` is added to `tsconfig` `include` so `npm run typecheck` covers it.

## File Structure (Milestone 9)

- Test: `test/m9-scenario.test.ts` — the asserted full-stack scenario (shared `buildSite()` + focused `it` blocks).
- Create: `examples/content-site.ts` — runnable narrated end-to-end script.
- Modify: `package.json` — add `tsx` devDependency + `"example"` script.
- Modify: `tsconfig.json` — add `"examples"` to `include`.
- Create: `README.md` — concise v1 overview, quickstart, run/test commands, status.

---

### Task 1: `test/m9-scenario.test.ts` — full-stack scenario

**Files:**
- Test: `test/m9-scenario.test.ts` (test-only; uses existing `src/`)

- [ ] **Step 1: Write the failing test `test/m9-scenario.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { TypeRegistry } from "../src/type-registry";
import { typeAwareDecision } from "../src/type-aware-decision";
import { makeRegistryValidator } from "../src/registry-validator";
import { SemanticIndex } from "../src/semantic-index";
import { MockEmbeddingPort } from "../src/embedding-port";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { makeToolset, type ToolsetBinding } from "../src/toolset";
import { serializeArtifact, restoreArtifact, MemoryStorage } from "../src/storage";
import { Replay } from "../src/replay";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function buildSite() {
  const registry = new TypeRegistry();
  registry.register("PageContent", {
    decompose: "opaque",
    validate: (v) => {
      const o = v as { title?: unknown };
      if (typeof v !== "object" || v === null || typeof o.title !== "string") {
        throw new Error("PageContent requires a string title");
      }
    },
    embedText: (v) => {
      const o = v as { title?: string; body?: string };
      return `${o.title ?? ""} ${o.body ?? ""}`.trim();
    },
  });

  const clock = new FixedClock(0);
  const deps: TreeDeps = {
    idGen: new SeqIdGen(),
    clock,
    decision: typeAwareDecision(sizeBasedDecision(1), registry),
  };
  const tree = ArtifactTree.fromJson({ site: { pages: {} }, brandFacts: {} }, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const embedding = new MockEmbeddingPort();
  const vectors = new MemoryVectorIndex();
  const index = new SemanticIndex(tree, addressing, embedding, vectors, registry);
  const mutator = new Mutator(tree, addressing, log, {
    clock,
    validate: makeRegistryValidator(registry),
    ...index.hooks(),
  });

  // Admin seeds brand facts (plain tagged string leaves).
  mutator.insert({ path: "/brandFacts" }, "price", "2990", { tags: ["brand-fact"] });
  mutator.insert({ path: "/brandFacts" }, "tagline", "Fast and simple", { tags: ["brand-fact"] });

  // Planner scaffolds typed, tagged page stubs (one opaque PageContent leaf each).
  for (const slug of ["home", "pricing", "about"]) {
    const title = slug[0].toUpperCase() + slug.slice(1);
    mutator.insert(
      { path: "/site/pages" },
      slug,
      { title, body: "" },
      { type: "PageContent", tags: ["page", `slug:${slug}`] },
    );
  }

  const tools = (binding: ToolsetBinding) => makeToolset({ tree, addressing, log, mutator, index }, binding);
  return { registry, clock, tree, addressing, log, embedding, vectors, index, mutator, tools };
}

describe("M9 content-site scenario (full stack)", () => {
  it("scoped writers fill pages; an editor finds the right page by meaning and lists pages by tag", async () => {
    const w = buildSite();

    const pricer = w.tools({ owner: "writer:pricing", writeScope: "/site/pages/pricing" });
    const facts = await pricer.find({ tag: "brand-fact" });
    expect(facts.ok).toBe(true);
    if (facts.ok) expect(facts.value.length).toBe(2);
    expect(
      (await pricer.patch({ path: "/site/pages/pricing" }, { op: "set", value: { title: "Pricing", body: "plans and cost" } })).ok,
    ).toBe(true);

    const homer = w.tools({ owner: "writer:home", writeScope: "/site/pages/home" });
    expect(
      (await homer.patch({ path: "/site/pages/home" }, { op: "set", value: { title: "Home", body: "welcome here" } })).ok,
    ).toBe(true);

    await w.index.reindex();

    const editor = w.tools({ readScope: "/site" });
    const found = await editor.search("Pricing plans and cost");
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.value.results[0].path).toBe("/site/pages/pricing");

    const pages = await editor.find({ tag: "page" });
    expect(pages.ok).toBe(true);
    if (pages.ok) {
      expect(pages.value.map((h) => h.path).sort()).toEqual([
        "/site/pages/about",
        "/site/pages/home",
        "/site/pages/pricing",
      ]);
    }
  });

  it("a writer scoped to its page cannot edit a sibling page or brand facts", async () => {
    const w = buildSite();
    const pricer = w.tools({ owner: "writer:pricing", writeScope: "/site/pages/pricing" });

    const sibling = await pricer.patch({ path: "/site/pages/home" }, { op: "set", value: { title: "Home", body: "hijacked" } });
    expect(sibling.ok).toBe(false);
    if (!sibling.ok) expect(sibling.error.code).toBe("SCOPE_VIOLATION");

    const fact = await pricer.patch({ path: "/brandFacts/price" }, { op: "set", value: "0" });
    expect(fact.ok).toBe(false);

    const own = await pricer.patch({ path: "/site/pages/pricing" }, { op: "set", value: { title: "Pricing", body: "ok" } });
    expect(own.ok).toBe(true);
  });

  it("type validation rejects a page missing its title and leaves the page unchanged", async () => {
    const w = buildSite();
    const pricer = w.tools({ writeScope: "/site/pages/pricing" });

    const bad = await pricer.patch({ path: "/site/pages/pricing" }, { op: "set", value: { body: "no title" } });
    expect(bad.ok).toBe(false);

    const got = await pricer.get({ path: "/site/pages/pricing" });
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value.content).toEqual({ title: "Pricing", body: "" });
  });

  it("the whole site persists and restores with semantic search intact", async () => {
    const w = buildSite();
    await w
      .tools({ writeScope: "/site/pages/pricing" })
      .patch({ path: "/site/pages/pricing" }, { op: "set", value: { title: "Pricing", body: "plans and cost" } });
    await w.index.reindex();

    const store = new MemoryStorage();
    await store.save(serializeArtifact(w.tree, w.log, w.vectors));
    const loaded = (await store.load())!;

    const freshDeps: TreeDeps = {
      idGen: new SeqIdGen(),
      clock: new FixedClock(0),
      decision: typeAwareDecision(sizeBasedDecision(1), w.registry),
    };
    const freshVectors = new MemoryVectorIndex();
    const { tree: rtree, log: rlog } = restoreArtifact(loaded, freshDeps, freshVectors);
    const rindex = new SemanticIndex(rtree, new Addressing(rtree), new MockEmbeddingPort(), freshVectors, w.registry);

    expect(rtree.toJson()).toEqual(w.tree.toJson());
    expect(rlog.entries()).toEqual(w.log.entries());

    const r = await rindex.search("Pricing plans and cost");
    expect(r.results[0].path).toBe("/site/pages/pricing");
  });

  it("time-travel recovers an earlier version of a page", () => {
    const w = buildSite();
    const vScaffold = w.log.length();
    w.mutator.set({ path: "/site/pages/pricing" }, { title: "Pricing", body: "final copy" });

    const replay = new Replay(w.tree, w.log);
    expect(replay.getAt("/site/pages/pricing", vScaffold)).toEqual({ title: "Pricing", body: "" });
    expect(replay.getAt("/site/pages/pricing", w.log.length())).toEqual({ title: "Pricing", body: "final copy" });
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/m9-scenario.test.ts`
Expected: PASS (5 tests) — every capability was built in M1–M8.

**If any test FAILS:** do NOT weaken the assertion. Diagnose whether it is (a) a test-wiring mistake in THIS file (fix the test) or (b) a genuine bug in an `src/` module (STOP and report the exact failure + which module — it would be escalated and fixed in its own step). The most likely wiring pitfalls: the deterministic search ranking (the query must exactly equal the pricing page's `embedText` `"Pricing plans and cost"`); and the `vScaffold` version (must be captured before the writer's `set`).

- [ ] **Step 3: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all suites pass; no type errors.

- [ ] **Step 4: Commit**

```bash
git add test/m9-scenario.test.ts
git commit -m "test: M9 content-site scenario — full stack end-to-end"
```

---

### Task 2: `examples/content-site.ts` — runnable narrated example

**Files:**
- Create: `examples/content-site.ts`
- Modify: `package.json` (add `tsx` devDependency + `"example"` script)
- Modify: `tsconfig.json` (add `"examples"` to `include`)

- [ ] **Step 1: Write `examples/content-site.ts`**

```ts
/**
 * Arbor end-to-end example — a tiny content-generation "site" built and edited by
 * scoped agents over one shared artifact tree. Run with:  npm run example
 *
 * It wires the full stack (typed tree + semantic index + reversible log + scoped
 * toolset + storage + replay) and narrates each step to stdout.
 */
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { TypeRegistry } from "../src/type-registry";
import { typeAwareDecision } from "../src/type-aware-decision";
import { makeRegistryValidator } from "../src/registry-validator";
import { SemanticIndex } from "../src/semantic-index";
import { MockEmbeddingPort } from "../src/embedding-port";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { makeToolset } from "../src/toolset";
import { serializeArtifact, restoreArtifact, MemoryStorage } from "../src/storage";
import { Replay } from "../src/replay";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { SystemClock } from "../src/clock";

// 1. Register a node type: each page is one opaque, typed, embeddable unit.
const registry = new TypeRegistry();
registry.register("PageContent", {
  decompose: "opaque",
  validate: (v) => {
    const o = v as { title?: unknown };
    if (typeof v !== "object" || v === null || typeof o.title !== "string") {
      throw new Error("PageContent requires a string title");
    }
  },
  embedText: (v) => {
    const o = v as { title?: string; body?: string };
    return `${o.title ?? ""} ${o.body ?? ""}`.trim();
  },
});

// 2. Build the shared artifact + wire validation, type-aware decomposition, and the index.
//    Threshold 1 keeps empty scaffolds (`{}`) navigable objects rather than opaque leaves.
const vectors = new MemoryVectorIndex();
const deps: TreeDeps = {
  idGen: new SeqIdGen(),
  clock: new SystemClock(),
  decision: typeAwareDecision(sizeBasedDecision(1), registry),
};
const tree = ArtifactTree.fromJson({ site: { pages: {} }, brandFacts: {} }, deps);
const addressing = new Addressing(tree);
const log = new EventLog();
const index = new SemanticIndex(tree, addressing, new MockEmbeddingPort(), vectors, registry);
const mutator = new Mutator(tree, addressing, log, {
  clock: deps.clock,
  validate: makeRegistryValidator(registry),
  ...index.hooks(),
});

// 3. Admin seeds brand facts and scaffolds typed page stubs.
mutator.insert({ path: "/brandFacts" }, "price", "2990", { tags: ["brand-fact"] });
for (const slug of ["home", "pricing", "about"]) {
  const title = slug[0].toUpperCase() + slug.slice(1);
  mutator.insert({ path: "/site/pages" }, slug, { title, body: "" }, { type: "PageContent", tags: ["page", `slug:${slug}`] });
}
const vScaffold = log.length();
console.log("1. scaffolded:", JSON.stringify(tree.toJson()));

// 4. A content-writer agent, scoped to its own page, reads a brand fact then writes.
const pricer = makeToolset({ tree, addressing, log, mutator, index }, { owner: "writer:pricing", writeScope: "/site/pages/pricing" });
const facts = await pricer.find({ tag: "brand-fact" });
console.log("2. pricing writer can read brand facts:", facts.ok && facts.value.map((h) => h.path));
await pricer.patch({ path: "/site/pages/pricing" }, { op: "set", value: { title: "Pricing", body: "plans and cost" } });

// A write outside its scope is refused as a structured error (no throw).
const refused = await pricer.patch({ path: "/site/pages/home" }, { op: "set", value: { title: "Home", body: "nope" } });
console.log("3. cross-page write refused:", refused.ok === false && refused.error.code);

// 5. Reindex, then an editor searches the site by meaning.
await index.reindex();
const editor = makeToolset({ tree, addressing, log, mutator, index }, { readScope: "/site" });
const hit = await editor.search("Pricing plans and cost");
console.log("4. semantic search top hit:", hit.ok && hit.value.results[0]?.path);

// 6. Persist the whole artifact and restore it into fresh components — search still works.
const store = new MemoryStorage();
await store.save(serializeArtifact(tree, log, vectors));
const loaded = (await store.load())!;
const freshVectors = new MemoryVectorIndex();
const restoreDeps: TreeDeps = {
  idGen: new SeqIdGen(),
  clock: new SystemClock(),
  decision: typeAwareDecision(sizeBasedDecision(1), registry),
};
const { tree: rtree } = restoreArtifact(loaded, restoreDeps, freshVectors);
const rindex = new SemanticIndex(rtree, new Addressing(rtree), new MockEmbeddingPort(), freshVectors, registry);
const afterRestore = await rindex.search("Pricing plans and cost");
console.log("5. search after restore:", afterRestore.results[0]?.path);

// 7. Time-travel: read the pricing page as it was right after scaffolding vs now.
const replay = new Replay(tree, log);
console.log("6. pricing page at scaffold:", replay.getAt("/site/pages/pricing", vScaffold));
console.log("7. pricing page now:       ", replay.getAt("/site/pages/pricing", log.length()));
```

- [ ] **Step 2: Add `"examples"` to `tsconfig.json` `include`**

Change the `include` array from `["src", "test"]` to:

```json
  "include": ["src", "test", "examples"]
```

- [ ] **Step 3: Add the `tsx` devDependency + `example` script to `package.json`**

In `scripts`, add an `"example"` entry:

```json
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "example": "tsx examples/content-site.ts"
  },
```

In `devDependencies`, add `tsx`:

```json
    "tsx": "^4.19.0"
```

- [ ] **Step 4: Typecheck (hard gate) — confirms the example compiles**

Run: `npm run typecheck`
Expected: clean (now also type-checks `examples/`).

- [ ] **Step 5: Install tsx and run the example (best-effort)**

Run: `npm install` then `npm run example`
Expected output (paths deterministic; `7.` shows the recovered earlier version): lines `1.`–`7.`, e.g. `4. semantic search top hit: /site/pages/pricing`, `5. search after restore: /site/pages/pricing`, and `6.` showing `{ title: 'Pricing', body: '' }` vs `7.` showing `{ title: 'Pricing', body: 'plans and cost' }`.

**If `npm install` fails (no network in this environment):** that is acceptable — report DONE_WITH_CONCERNS noting the example **typechecks** (Step 4, the hard gate) and its behavior is independently proven by Task 1's scenario test, and that running it needs `npm install` (`npx tsx examples/content-site.ts`). Do NOT block the task on environment network access.

- [ ] **Step 6: Commit**

```bash
git add examples/content-site.ts package.json tsconfig.json package-lock.json
git commit -m "feat: runnable content-site example (npm run example) + tsx dev dep"
```

(If `npm install` did not run, there is no `package-lock.json` change — `git add` it only if present.)

---

### Task 3: `README.md` — concise v1 overview

**Files:**
- Create: `README.md` (repo root)

- [ ] **Step 1: Write `README.md`**

```markdown
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
```

- [ ] **Step 2: Verify the quickstart compiles (sanity check)**

Read your `README.md` quickstart against the actual signatures: `ArtifactTree.fromJson(value, {idGen, clock, decision})`; `makeToolset({tree, addressing, log, mutator, index?}, {owner?, writeScope?, readScope?})`; `patch(ref, {op:"insert", key, value})` returns `Promise<ToolResult<{id?}>>`; `get(ref)` returns `Promise<ToolResult<GetResult>>` whose `value.content` is the node value. Confirm the snippet matches. (No build step — README code is illustrative.)

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README — v1 core overview, quickstart, status"
```

---

## Milestone 9 — Definition of Done

- [ ] `npm test` — all suites pass (M1–M9), including the 5-test `m9-scenario` capstone.
- [ ] `npm run typecheck` — no errors (now also covering `examples/`).
- [ ] `examples/content-site.ts` exists, typechecks, and runs via `npm run example` (best-effort on execution given environment network; typecheck + the scenario test are the hard proof).
- [ ] `README.md` documents the stack, a minimal wiring quickstart, run/test commands, and v1 status.
- [ ] **Arbor v1 core is complete:** an agent can be handed a scoped toolset over a typed, semantically-indexed, persistable, time-travellable shared artifact — proven end-to-end.

---

## Roadmap: after v1

- Build the real SEO **content-generator** on Arbor (separate downstream project, its own spec): register its 8 Zod schemas as Arbor node types; `content-writer` concurrency=6 with `writeScope=/pages/<slug>`.
- Post-v1 adapters as needed: LangChain/MCP tool wrappers, DB-backed storage/vector ports, CRDT backend.

---

## Self-Review (against the spec)

**Spec coverage (this plan):** content-generator-shaped e2e fixtures → Task 1 (`m9-scenario.test.ts`: typed pages, scoped writers, editor search, persist/restore, time-travel — exercises M1–M8); runnable `examples/` script wiring the full stack → Task 2 (`examples/content-site.ts` + `npm run example`); living-docs → Task 2 (narrated example) + Task 3 (README). No new `src/` code (integration milestone). Post-v1 items (LangChain/MCP, DB adapters, CRDT, the downstream content-generator) explicitly deferred in Scope + README Status.

**Placeholder scan:** No TBD/TODO; every code step has full code; every run step has an exact command + expected result. Task 1 step 2 includes a concrete diagnosis path (not a placeholder) for the only realistic failure modes (search-ranking query, `vScaffold` capture). Task 2 step 5 has an explicit environment-network fallback.

**Type consistency:** `buildSite()` wiring matches verified signatures — `ArtifactTree.fromJson(value, {idGen, clock, decision})`; `typeAwareDecision(base, registry)` (base first); `makeRegistryValidator(registry): Validator`; `new SemanticIndex(tree, addressing, embedding, vectors, registry)` (registry 5th); `new Mutator(tree, addressing, log, {clock, validate, onChange, onRemove})` via `...index.hooks()`; `TypeDef {validate?(v), decompose?, embedText?(v)}`; `mutator.insert(parentRef, key, value, {type, tags})`; `makeToolset({tree, addressing, log, mutator, index}, binding)`; toolset `find`/`search`/`patch`/`get` return `Promise<ToolResult<…>>`; `PatchOp` `{op:"set", value}` / `{op:"insert", key, value}` (no `type` field — types set via the Mutator at scaffold time); `serializeArtifact(tree, log, vectors)` + `restoreArtifact(stored, deps, vectors)`; `new Replay(tree, log).getAt(path, version)`. The example mirrors these. `sizeBasedDecision(1)` everywhere a fixture inserts into empty scaffolds (documented gotcha). Search assertions use a query equal to the target page's exact `embedText` for deterministic cosine ranking with `MockEmbeddingPort`.
