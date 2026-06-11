# Arbor — M8: Scoped Agent Toolset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the whole engine to an agent as one scoped, in-process toolset — `makeToolset({tree, addressing, log, mutator, index?}, {owner?, writeScope?, readScope?})` returning `{describe, get, find, search, patch, history}` — where every call returns a structured `{ok|error}` result, writes are confined to `writeScope`, reads to `readScope`, and `meta` is serialized at the boundary.

**Architecture:** `makeToolset` is a factory that composes the existing components (builds a `Navigator` internally; takes the `Mutator`, `EventLog`, and optional `SemanticIndex`) and wraps each capability as an **async** method returning `ToolResult<T>` = `{ok:true, value}` | `{ok:false, error:{code, message}}`. A `run()` helper catches `ArborError` (and any error) and converts it to a structured result — errors never cross the agent boundary as throws (spec §8). Scoping lives in the binding: `patch` passes `writeScope`/`owner` to the `Mutator` (which already enforces them); `describe`/`get` reject refs outside `readScope`; `find` filters to it; `search` constrains `under` to it. `get` returns a deep-cloned `meta` (closing the M4 known nit). All methods are async so the toolset is uniform and MCP/remote-ready.

**Tech Stack:** Node ≥20.6, TypeScript (ESM, strict), Vitest. No new dependencies (LangChain `tool()` / MCP wrapping is a thin consumer-side adapter, deferred). Builds on M1–M7.

---

## Scope of THIS plan (Milestone 8)

Covers spec §6 (the agent-facing tool-surface: `describe`/`get`/`find`/`search`/`patch`/`history`, scoped via the toolset binding, self-describing + structured results) and §10.8. Produces working, testable software: hand an agent a scoped toolset and it can navigate, search, and mutate the artifact within its scope, getting structured results.

**Out of scope here (later milestones):** LangChain `tool()` wrappers and the MCP-server adapter (both are thin, consumer-side or fase-2 adapters over this toolset — deferred), the M9 scenario/example. Also deferred from the toolset surface: `getAt`/`revert` exposure (available directly via `Replay` from M7; exposing them as scoped tools — esp. `revert` as a scoped write — is a small later add).

## Design decisions (locked for M8)

1. **One factory, async methods, structured results.** `makeToolset(deps, binding)` returns a `Toolset` whose six methods are all `async` and return `ToolResult<T>`. A shared `run(fn)` wraps each: success → `{ok:true, value}`; thrown `ArborError` → `{ok:false, error:{code: e.code, message}}`; any other error → `{ok:false, error:{code:"ERROR", message}}`. The agent never sees a throw.
2. **Scoping is delegated where it already lives.** `patch` passes `{owner, writeScope, ifVersion}` to the `Mutator`, which already throws `ScopeViolationError`/`StaleVersionError` (→ structured error). For reads, the toolset enforces `readScope`: `describe` defaults its ref to `readScope` (or root) and rejects a described node outside it; `get` rejects refs outside it; `find` filters hits to it; `search` sets `under = readScope`. `within(path, scope)`: `scope === undefined || path === scope || path.startsWith(scope + "/")`.
3. **`meta` is serialized at the boundary.** `get` returns `{...result, meta: structuredClone(result.meta)}` so an agent mutating the returned `meta` can't corrupt tree state (closes M4 known-nit a).
4. **`patch` is one method, op-discriminated.** `patch(ref, {op:"set"|"insert"|"remove"|"move", ...})` dispatches to `mutator.set/insert/remove/move`; `insert`'s success value carries the new node id.
5. **`search` requires a configured `SemanticIndex`.** If `deps.index` is absent, `search` returns `{ok:false, error:{code:"INVALID_OP"}}` (a toolset without semantics still gives the other five tools).
6. **The factory builds its own `Navigator`** from `(tree, addressing)`; it takes the `Mutator`/`EventLog`/`index` as deps (the caller wired the Mutator with the index's hooks).

## File Structure (Milestone 8)

- Create: `src/toolset.ts` — `ToolResult`, `ToolsetDeps`, `ToolsetBinding`, `PatchOp`, `Toolset`, `makeToolset` (+ private `run`/`within`).
- Test: `test/toolset-read.test.ts`, `test/toolset-search-find.test.ts`, `test/toolset-patch-history.test.ts`, `test/m8-toolset.test.ts`.

(`toolset.ts` is one cohesive factory; it is built up across Tasks 1–3 by adding method groups, with the `Toolset` interface growing to match.)

---

### Task 1: `toolset.ts` — result types, scoping, `describe` + `get`

**Files:**
- Create: `src/toolset.ts`
- Test: `test/toolset-read.test.ts`

- [ ] **Step 1: Write the failing test `test/toolset-read.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { makeToolset, type ToolsetBinding } from "../src/toolset";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function setup(json: unknown, binding: ToolsetBinding = {}) {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson(json as never, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock });
  const toolset = makeToolset({ tree, addressing, log, mutator }, binding);
  return { tree, addressing, log, mutator, toolset };
}

describe("Toolset.describe / get", () => {
  it("describe with no ref defaults to readScope and lists its children", async () => {
    const { toolset } = setup({ pages: { home: {}, about: {} }, other: {} }, { readScope: "/pages" });
    const r = await toolset.describe();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.children.map((c) => c.key).sort()).toEqual(["about", "home"]);
  });

  it("describe with no ref and no readScope defaults to the root", async () => {
    const { toolset } = setup({ a: 1, b: 2 });
    const r = await toolset.describe();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.node.path).toBe("");
  });

  it("get returns a value with a CLONED meta (mutating it does not affect the tree)", async () => {
    const { tree, addressing, toolset } = setup({ a: "x" });
    const r = await toolset.get({ path: "/a" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      r.value.meta.version = 999;
      expect(addressing.byPath("/a")!.meta.version).toBe(0);
    }
  });

  it("get outside readScope returns a structured SCOPE_VIOLATION error (no throw)", async () => {
    const { toolset } = setup({ pages: { home: "h" }, secret: "s" }, { readScope: "/pages" });
    const r = await toolset.get({ path: "/secret" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SCOPE_VIOLATION");
  });

  it("a missing ref returns a structured NODE_NOT_FOUND error", async () => {
    const { toolset } = setup({ a: "x" });
    const r = await toolset.get({ path: "/nope" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NODE_NOT_FOUND");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/toolset-read.test.ts`
Expected: FAIL — cannot resolve `../src/toolset`.

- [ ] **Step 3: Write `src/toolset.ts`**

```ts
import type { NodeId } from "./types";
import type { ArtifactTree } from "./artifact-tree";
import type { Addressing } from "./addressing";
import type { EventLog } from "./event-log";
import type { Mutator } from "./mutator";
import type { SemanticIndex } from "./semantic-index";
import {
  Navigator,
  type DescribeOpts,
  type DescribeResult,
  type GetOpts,
  type GetResult,
} from "./navigator";
import { type Ref, ArborError, ScopeViolationError } from "./errors";

/** Every toolset call returns this — errors are structured, never thrown across the agent boundary. */
export type ToolResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

export interface ToolsetDeps {
  tree: ArtifactTree;
  addressing: Addressing;
  log: EventLog;
  mutator: Mutator;
  index?: SemanticIndex;
}

export interface ToolsetBinding {
  owner?: string;
  /** JSON Pointer prefix: writes must be at or under it (enforced by the Mutator). */
  writeScope?: string;
  /** JSON Pointer prefix: reads are confined to it. */
  readScope?: string;
}

export interface Toolset {
  describe(ref?: Ref, opts?: DescribeOpts): Promise<ToolResult<DescribeResult>>;
  get(ref: Ref, opts?: GetOpts): Promise<ToolResult<GetResult>>;
}

/** path is within scope if scope is unset, equal, or an ancestor prefix. */
function within(path: string, scope: string | undefined): boolean {
  return scope === undefined || path === scope || path.startsWith(scope + "/");
}

/** Run a tool body, converting thrown errors into a structured ToolResult. */
async function run<T>(fn: () => T | Promise<T>): Promise<ToolResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    if (e instanceof ArborError) return { ok: false, error: { code: e.code, message: e.message } };
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: { code: "ERROR", message } };
  }
}

/** A scoped, agent-facing bundle of tools returning structured results. */
export function makeToolset(deps: ToolsetDeps, binding: ToolsetBinding = {}): Toolset {
  const { tree, addressing } = deps;
  const navigator = new Navigator(tree, addressing);

  return {
    describe: (ref, opts) =>
      run(() => {
        const target: Ref = ref ?? (binding.readScope !== undefined ? { path: binding.readScope } : { path: "" });
        const r = navigator.describe(target, opts);
        if (!within(r.node.path, binding.readScope)) {
          throw new ScopeViolationError(r.node.path, binding.readScope!);
        }
        return r;
      }),

    get: (ref, opts) =>
      run(() => {
        const r = navigator.get(ref, opts);
        if (!within(r.path, binding.readScope)) {
          throw new ScopeViolationError(r.path, binding.readScope!);
        }
        return { ...r, meta: structuredClone(r.meta) };
      }),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/toolset-read.test.ts`
Expected: PASS (5 tests). Then `npx vitest run` — no regressions.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/toolset.ts test/toolset-read.test.ts
git commit -m "feat: scoped Toolset factory with describe/get (structured results, meta clone)"
```

---

### Task 2: `find` + `search`

**Files:**
- Modify: `src/toolset.ts` (add `find`/`search` to `Toolset` + the returned object)
- Test: `test/toolset-search-find.test.ts`

- [ ] **Step 1: Write the failing test `test/toolset-search-find.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { SemanticIndex } from "../src/semantic-index";
import { MockEmbeddingPort } from "../src/embedding-port";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { makeToolset, type ToolsetBinding } from "../src/toolset";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function setup(json: unknown, binding: ToolsetBinding = {}, withIndex = true) {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson(json as never, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const index = withIndex ? new SemanticIndex(tree, addressing, new MockEmbeddingPort(), new MemoryVectorIndex()) : undefined;
  const mutator = new Mutator(tree, addressing, log, { clock, ...(index ? index.hooks() : {}) });
  const toolset = makeToolset({ tree, addressing, log, mutator, index }, binding);
  return { tree, addressing, log, mutator, index, toolset };
}

describe("Toolset.find", () => {
  it("finds by tag and filters hits to readScope", async () => {
    const { mutator, toolset } = setup({ a: {}, b: {} }, { readScope: "/a" });
    mutator.insert({ path: "/a" }, "x", "1", { tags: ["t"] });
    mutator.insert({ path: "/b" }, "y", "2", { tags: ["t"] });
    const r = await toolset.find({ tag: "t" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((h) => h.path)).toEqual(["/a/x"]); // /b/y excluded by readScope
  });
});

describe("Toolset.search", () => {
  it("returns semantic results, scoped to readScope via under", async () => {
    const { mutator, index, toolset } = setup({ docs: {}, junk: {} }, { readScope: "/docs" });
    mutator.insert({ path: "/docs" }, "a", "the quick brown fox");
    mutator.insert({ path: "/junk" }, "b", "the quick brown fox");
    await index!.reindex();
    const r = await toolset.search("the quick brown fox");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.results.every((h) => h.path.startsWith("/docs"))).toBe(true);
  });

  it("returns INVALID_OP when the toolset has no semantic index", async () => {
    const { toolset } = setup({ a: 1 }, {}, false);
    const r = await toolset.search("anything");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_OP");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/toolset-search-find.test.ts`
Expected: FAIL — `toolset.find`/`toolset.search` are not functions.

- [ ] **Step 3: Modify `src/toolset.ts`**

Add `find`/`search` types to the imports — extend the navigator import and add the semantic-index types:

```ts
import {
  Navigator,
  type DescribeOpts,
  type DescribeResult,
  type GetOpts,
  type GetResult,
  type FindSelector,
  type FindOpts,
  type FindHit,
} from "./navigator";
import type { SearchOpts, SearchResult } from "./semantic-index";
import { type Ref, ArborError, ScopeViolationError, InvalidOpError } from "./errors";
```

Add these two methods to the `Toolset` interface (after `get`):

```ts
  find(selector: FindSelector, opts?: FindOpts): Promise<ToolResult<FindHit[]>>;
  search(query: string, opts?: SearchOpts): Promise<ToolResult<SearchResult>>;
```

Add these two methods to the object returned by `makeToolset` (after `get`):

```ts
    find: (selector, opts) =>
      run(() => {
        const hits = navigator.find(selector, opts);
        return binding.readScope === undefined ? hits : hits.filter((h) => within(h.path, binding.readScope));
      }),

    search: (query, opts = {}) =>
      run(async () => {
        if (!deps.index) throw new InvalidOpError("no semantic index configured for this toolset");
        const under = opts.under ?? binding.readScope;
        return deps.index.search(query, { ...opts, under });
      }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/toolset-search-find.test.ts`
Expected: PASS (3 tests). Then `npx vitest run` — no regressions.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/toolset.ts test/toolset-search-find.test.ts
git commit -m "feat: Toolset find + search (scoped to readScope)"
```

---

### Task 3: `patch` + `history`

**Files:**
- Modify: `src/toolset.ts` (add `PatchOp` type; add `patch`/`history` to `Toolset` + the returned object)
- Test: `test/toolset-patch-history.test.ts`

- [ ] **Step 1: Write the failing test `test/toolset-patch-history.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { makeToolset, type ToolsetBinding } from "../src/toolset";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function setup(json: unknown, binding: ToolsetBinding = {}) {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson(json as never, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock });
  const toolset = makeToolset({ tree, addressing, log, mutator }, binding);
  return { tree, addressing, log, mutator, toolset };
}

describe("Toolset.patch", () => {
  it("set applies within writeScope and stamps owner", async () => {
    const { tree, addressing, toolset } = setup({ pages: { a: "old" } }, { writeScope: "/pages/a", owner: "agent-1" });
    const r = await toolset.patch({ path: "/pages/a" }, { op: "set", value: "new" });
    expect(r.ok).toBe(true);
    expect(tree.toJson()).toEqual({ pages: { a: "new" } });
    expect(addressing.byPath("/pages/a")!.meta.owner).toBe("agent-1");
  });

  it("insert returns the new node id", async () => {
    const { tree, toolset } = setup({ docs: {} });
    const r = await toolset.patch({ path: "/docs" }, { op: "insert", key: "k", value: "v" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(typeof r.value.id).toBe("string");
    expect(tree.toJson()).toEqual({ docs: { k: "v" } });
  });

  it("a write outside writeScope returns a structured SCOPE_VIOLATION and changes nothing", async () => {
    const { tree, toolset } = setup({ pages: { a: "x", b: "y" } }, { writeScope: "/pages/a" });
    const r = await toolset.patch({ path: "/pages/b" }, { op: "set", value: "z" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SCOPE_VIOLATION");
    expect(tree.toJson()).toEqual({ pages: { a: "x", b: "y" } });
  });

  it("remove and move work", async () => {
    const { tree, addressing, toolset } = setup({ from: { x: "v" }, to: {} });
    const xId = addressing.byPath("/from/x")!.id;
    expect((await toolset.patch({ id: xId }, { op: "move", to: { path: "/to" }, key: "x" })).ok).toBe(true);
    expect(tree.toJson()).toEqual({ from: {}, to: { x: "v" } });
    expect((await toolset.patch({ path: "/to/x" }, { op: "remove" })).ok).toBe(true);
    expect(tree.toJson()).toEqual({ from: {}, to: {} });
  });
});

describe("Toolset.history", () => {
  it("returns all events, or those touching a given node", async () => {
    const { addressing, toolset, mutator } = setup({ docs: {} });
    mutator.insert({ path: "/docs" }, "a", "1");
    mutator.insert({ path: "/docs" }, "b", "2");
    const aId = addressing.byPath("/docs/a")!.id;
    const all = await toolset.history();
    expect(all.ok).toBe(true);
    if (all.ok) expect(all.value.length).toBe(2);
    const justA = await toolset.history({ id: aId });
    expect(justA.ok).toBe(true);
    if (justA.ok) expect(justA.value.every((e) => e.targetId === aId)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/toolset-patch-history.test.ts`
Expected: FAIL — `toolset.patch`/`toolset.history` are not functions.

- [ ] **Step 3: Modify `src/toolset.ts`**

Add the `MutationEvent` type to the event-log import, and `NodeNotFoundError` to the errors import:

```ts
import type { EventLog, MutationEvent } from "./event-log";
import { type Ref, ArborError, ScopeViolationError, InvalidOpError, NodeNotFoundError } from "./errors";
```

Add the `PatchOp` type (after `ToolResult`):

```ts
export type PatchOp =
  | { op: "set"; value: Json; ifVersion?: number }
  | { op: "insert"; key: string | number; value: Json; ifVersion?: number }
  | { op: "remove"; ifVersion?: number }
  | { op: "move"; to: Ref; key: string | number; ifVersion?: number };
```

and add the `Json` import at the top:

```ts
import type { Json, NodeId } from "./types";
```

Add these two methods to the `Toolset` interface (after `search`):

```ts
  patch(ref: Ref, op: PatchOp): Promise<ToolResult<{ id?: NodeId }>>;
  history(ref?: Ref, opts?: { limit?: number }): Promise<ToolResult<MutationEvent[]>>;
```

Add these two methods to the object returned by `makeToolset` (after `search`):

```ts
    patch: (ref, op) =>
      run<{ id?: NodeId }>(() => {
        const common = { owner: binding.owner, writeScope: binding.writeScope, ifVersion: op.ifVersion };
        switch (op.op) {
          case "set":
            deps.mutator.set(ref, op.value, common);
            return {};
          case "insert":
            return { id: deps.mutator.insert(ref, op.key, op.value, common) };
          case "remove":
            deps.mutator.remove(ref, common);
            return {};
          case "move":
            deps.mutator.move(ref, op.to, op.key, common);
            return {};
        }
      }),

    history: (ref, opts = {}) =>
      run(() => {
        const all = [...deps.log.entries()];
        let events = all;
        if (ref !== undefined) {
          const node = "id" in ref ? addressing.byId(ref.id) : addressing.byPath(ref.path);
          if (!node) throw new NodeNotFoundError(ref);
          const id = node.id;
          events = all.filter((e) => e.targetId === id);
        }
        return opts.limit !== undefined ? events.slice(-opts.limit) : events;
      }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/toolset-patch-history.test.ts`
Expected: PASS (5 tests). Then `npx vitest run` — no regressions.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/toolset.ts test/toolset-patch-history.test.ts
git commit -m "feat: Toolset patch (scoped writes) + history"
```

---

### Task 4: Capstone — two scoped agents on a content-generator-shaped site

**Files:**
- Test: `test/m8-toolset.test.ts` (test-only; a scoped page-writer + a reader exercise the full toolset)

- [ ] **Step 1: Write the failing test `test/m8-toolset.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { SemanticIndex } from "../src/semantic-index";
import { MockEmbeddingPort } from "../src/embedding-port";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { makeToolset } from "../src/toolset";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function world() {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson({ pages: { home: {} }, brandFacts: {} }, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const index = new SemanticIndex(tree, addressing, new MockEmbeddingPort(), new MemoryVectorIndex());
  const mutator = new Mutator(tree, addressing, log, { clock, ...index.hooks() });
  // seed a brand fact (unscoped admin write)
  mutator.insert({ path: "/brandFacts" }, "price", "2990", { tags: ["brand-fact:price"] });
  return { tree, addressing, log, mutator, index };
}

describe("M8 toolset integration", () => {
  it("a writer scoped to /pages/home can edit its page but not a sibling or brandFacts", async () => {
    const w = world();
    const writer = makeToolset(w, { owner: "content-writer", writeScope: "/pages/home", readScope: undefined });

    // can read brandFacts globally (readScope unset)
    const facts = await writer.find({ tag: "brand-fact:price" });
    expect(facts.ok && facts.value.map((h) => h.path)).toEqual(["/brandFacts/price"]);

    // can write its own page
    const ins = await writer.patch({ path: "/pages/home" }, { op: "insert", key: "title", value: "Welcome" });
    expect(ins.ok).toBe(true);
    expect(w.tree.toJson()).toEqual({ pages: { home: { title: "Welcome" } }, brandFacts: { price: "2990" } });

    // cannot write outside its scope
    const bad = await writer.patch({ path: "/brandFacts/price" }, { op: "set", value: "0" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("SCOPE_VIOLATION");
    expect(w.tree.toJson().brandFacts).toEqual({ price: "2990" }); // unchanged
  });

  it("a reader scoped to /pages sees pages and searches within them; get returns a cloned meta", async () => {
    const w = world();
    const writer = makeToolset(w, { owner: "w", writeScope: "/pages/home" });
    await writer.patch({ path: "/pages/home" }, { op: "insert", key: "body", value: "pricing details and plans" });
    await w.index.reindex();

    const reader = makeToolset(w, { readScope: "/pages" });
    const found = await reader.search("pricing details and plans");
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.value.results.every((h) => h.path.startsWith("/pages"))).toBe(true);

    const got = await reader.get({ path: "/pages/home/body" });
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.value.content).toBe("pricing details and plans");
      got.value.meta.version = -1; // mutate the boundary copy
      expect(w.addressing.byPath("/pages/home/body")!.meta.version).not.toBe(-1);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `npx vitest run test/m8-toolset.test.ts`
Expected: PASS — every piece was built in Tasks 1–3. (If it fails, fix the corresponding source from the earlier task, not this test.)

- [ ] **Step 3: Run the full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all suites pass; no type errors.

- [ ] **Step 4: Commit**

```bash
git add test/m8-toolset.test.ts
git commit -m "test: M8 toolset end-to-end (scoped writer + reader over a site)"
```

---

## Milestone 8 — Definition of Done

- [ ] `npm test` — all suites pass (M1–M8).
- [ ] `npm run typecheck` — no errors.
- [ ] You can: `makeToolset({tree, addressing, log, mutator, index?}, {owner?, writeScope?, readScope?})` and hand an agent a bundle of `describe`/`get`/`find`/`search`/`patch`/`history` that all return `{ok|error}`; writes outside `writeScope` and reads outside `readScope` are rejected as structured errors; `get` returns a cloned `meta`; `search` is scoped via `under` and degrades to a structured `INVALID_OP` when no index is wired.

---

## Roadmap: subsequent plans

- **M9 — Scenario / example:** the content-generator-shaped end-to-end fixtures + a runnable `examples/` script wiring the full stack (tree + types + index + toolset) — the living-docs proof and the seed for building the real content-generator on Arbor. After M9, the Arbor v1 core is complete.
- **Future (out of v1):** LangChain `tool()` wrappers and an MCP-server adapter over `Toolset`; `getAt`/`revert` as scoped tools; DB-backed `StoragePort`/`VectorIndexPort`; CRDT backend.

---

## Self-Review (against the spec)

**Spec coverage (this plan):** §6 tool-surface — `describe`/`get` → Task 1; `find`/`search` → Task 2; `patch`/`history` → Task 3; scoping via the binding (`writeScope` delegated to the Mutator, `readScope` enforced/filtered in the toolset) → Tasks 1–3; structured results (no throws across the boundary) → `run()` (Task 1); `meta` serialized at the boundary (closes M4 nit a) → Task 1 (`get`). §10.8 `makeToolset` scoped factory → Task 1. End-to-end scoped multi-agent flow → Task 4. Deferred items (LangChain/MCP wrappers, `getAt`/`revert` exposure) listed in Scope/Roadmap.

**Placeholder scan:** No TBD/TODO; every code step has full code; every run step has an exact command + expected result. Task 4 step 2 is a "should already pass" capstone with rationale (not a placeholder).

**Type consistency:** `ToolResult<T>`, `ToolsetDeps` (`{tree, addressing, log, mutator, index?}`), `ToolsetBinding` (`{owner?, writeScope?, readScope?}`), `Toolset`, `makeToolset`, `within`, `run` defined in Task 1; the `Toolset` interface grows by adding `find`/`search` (Task 2) then `patch`/`history` (Task 3) — method signatures match the returned object literal's methods in each task. `PatchOp` (discriminated union over `op`) defined in Task 3, consumed by `patch`. Reused types: `DescribeOpts`/`DescribeResult`/`GetOpts`/`GetResult`/`FindSelector`/`FindOpts`/`FindHit` from `navigator.ts` (M4); `SearchOpts`/`SearchResult` from `semantic-index.ts` (M5); `MutationEvent` from `event-log.ts`; `Ref`/`ArborError`/`ScopeViolationError`/`InvalidOpError`/`NodeNotFoundError` from `errors.ts`; `Json`/`NodeId` from `types.ts`. `patch` passes `{owner, writeScope, ifVersion}` as `MutateOpts` to the existing `Mutator.set/insert/remove/move` (M3+ signatures); `Mutator.insert` returns `NodeId`, surfaced as `{id}`. `SemanticIndex.search(query, {under, ...})` (M5/M6) is called with `under = readScope`. No import cycle: `toolset.ts` imports `Navigator` (value, for `new`) + types of the rest; nothing imports `toolset`.
