# Arbor — M15: API Polish (pre-publish, P1 part 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze a publishable API: make `VectorIndexPort` async (unblocks pgvector/sqlite-vec without a future semver-major), deduplicate the scope-prefix logic and fix the lying read-scope error message, make `patch` return `{id, path, version}` and `find` report truncation, and ship the `createArbor()`/`restoreArbor()` facade that owns construction wiring AND the restore invariants (fresh vectors, SemanticIndex re-creation, the idGen-collision guard for plain storage restore — closing known-minor (a)).

**Architecture:** No behavioral redesign — the facade composes existing pieces exactly as `examples/content-site.ts` does by hand; the async port is a signature migration (Memory impl stays sync inside); toolset changes enrich returns without altering semantics. Everything is pre-publish breaking-change territory by design — the library is `private`, and the ONLY consumer (`content-generator-arbor`, which aliases straight into `src/`) is adapted in a separate follow-up (it will not compile against M15 until then; that is accepted and expected).

**Tech Stack:** Node ≥20.6, TypeScript (ESM, strict), Vitest. No new dependencies. Builds on M1–M14 (308 tests).

---

## Scope of THIS plan (Milestone 15)

Review P1 items: async `VectorIndexPort` · shared `isWithin()` + `ScopeViolationError` message fix · `patch` → `{id, path, version}` · `find` truncation marker · `createArbor()`/`restoreArbor()` facade (with the storage-restore idGen guard). **Consciously dropped from P1:** moving `Ref` from errors.ts to types.ts — a re-export in both modules would make the barrel's star-exports ambiguous; cosmetic benefit does not justify the churn. **Out of scope (M16, next plan):** the `arborkit` rename, LICENSE/CHANGELOG/CI, explicit exports map, README quickstart rewrite, `private` flip. **Follow-up (downstream, separate task):** adapt `content-generator-arbor` to the async port + new toolset returns.

## Design decisions (locked)

1. **Async port, sync default impl.** All six `VectorIndexPort` methods return Promises; `MemoryVectorIndex` keeps its Map logic, methods become `async`. `serializeArtifact`/`restoreArtifact` become async (they call `entries()`/`upsert()`); `SemanticIndex.reindex`/`search` await the port. This is a compiler-driven migration: change the port first, let `tsc` enumerate every call site.
2. **One `isWithin(path, scope)` in `jsonpointer.ts`** replaces the four copies (mutator `checkScope`, toolset `within`, navigator `find` within-check, semantic-index `search` under-filter). `scope === undefined` ⇒ true.
3. **`ScopeViolationError` message stops lying:** "Access outside scope" (it fires for reads too); the public field stays `scope`-named via RENAME `writeScope` → `scope` (pre-publish; update the few usages).
4. **`patch` returns `PatchResult {id, path, version}`:** set/insert/move → the target/new/moved node's id+path+post-op version; remove → the REMOVED node's id+old path with the PARENT's post-op version (the surviving bumped node).
5. **`find` returns `FindResult {hits, truncated}`.** `truncated: true` means "stopped at the limit — there MAY be more" (an exact-fit last hit also reports true; documented).
6. **Facade:** `createArbor(opts)` builds tree+log+addressing+optional SemanticIndex+Mutator (registry validator + type-aware decision + index hooks wired) and returns an `Arbor` handle with `toolset(binding)`, `replay`, `save()` (StoragePort), `saveDelta()`/`checkpoint({keepLast})` (DeltaStoragePort, internal high-water). `restoreArbor(opts)` prefers `delta` over `storage`, returns null when nothing persisted, always uses a FRESH vector index it upserts into, re-creates `SemanticIndex` (M10 seeds stale from meta), and guards the idGen against restored-node id collisions on the storage path (delta path already guards internally). Defaults: `UuidIdGen`, `SystemClock`, `sizeBasedDecision(200)`.

## File structure

- Modify: `src/vector-index-port.ts` (async port), `src/semantic-index.ts` + `src/storage.ts` + `src/delta.ts` (await propagation).
- Modify: `src/jsonpointer.ts` (`isWithin`), `src/errors.ts` (message + field), `src/mutator.ts` + `src/toolset.ts` + `src/navigator.ts` + `src/semantic-index.ts` (use `isWithin`; toolset returns).
- Create: `src/arbor.ts` (facade). Modify: `src/index.ts` (barrel export).
- Tests: adapt existing call sites (Task 1/3); new `test/m15-facade.test.ts`, `test/m15-toolset-returns.test.ts`.

### Reuse
- `examples/content-site.ts` — the manual wiring the facade replaces (reference for correct hook order).
- `restoreFromDelta`'s idGen guard (delta.ts) — the storage-path guard in the facade mirrors it.
- `SemanticIndex` ctor stale-seeding (M10) — makes restore-then-reindex work without extra code.

---

### Task 1: Async `VectorIndexPort` (compiler-driven migration)

**Files:**
- Modify: `src/vector-index-port.ts`, `src/semantic-index.ts`, `src/storage.ts`, `src/delta.ts`
- Modify: every test file `tsc`/vitest flags (expected: m5/m6 vector+storage tests, m9 scenario, m10 tx/stale tests, m12 storage, m13 persist/capstone, m14 reindex/tags tests, `examples/content-site.ts`, and the m11 packaging test's embedded smoke script)

This is a signature migration — strict TDD (red test first) does not apply; the "red" phase is the typecheck failing after Step 1, and the finish line is the full suite green again.

- [ ] **Step 1: Make the port async.** In `src/vector-index-port.ts`, replace the `VectorIndexPort` interface and `MemoryVectorIndex` method signatures (bodies stay identical, `async` added; `search`'s logic unchanged):

```ts
/** Stores per-node vectors and ranks by similarity. Async so DB-backed adapters
 *  (pgvector, sqlite-vec) can implement it; the in-memory default is sync inside. */
export interface VectorIndexPort {
  upsert(entries: VectorIndexEntry[]): Promise<void>;
  remove(nodeId: NodeId): Promise<void>;
  search(query: number[], k: number): Promise<VectorHit[]>;
  has(nodeId: NodeId): Promise<boolean>;
  size(): Promise<number>;
  entries(): Promise<VectorIndexEntry[]>;
}
```

Prefix every `MemoryVectorIndex` method with `async` (return types become Promises; bodies unchanged).

- [ ] **Step 2: Run `npm run typecheck` and collect every error.** Expected core call sites:
  - `src/semantic-index.ts`: `reindex()` — `await this.vectors.remove(id)` (both the pendingRemoval drain loop and the two scan-time removes and the post-await remove), `await this.vectors.upsert(upserts)`; `search()` — `const ranked = await this.vectors.search(queryVec, await this.vectors.size());`.
  - `src/storage.ts`: `serializeArtifact` → `export async function serializeArtifact(...): Promise<StoredArtifact>` with `vectors: await vectors.entries(),`; `restoreArtifact` → `export async function restoreArtifact(...): Promise<{...}>` with `await vectors.upsert(stored.vectors);`.
  - `src/delta.ts`: `persistCheckpoint` → `await store.writeCheckpoint(await serializeArtifact(tree, log, vectors));`; `restoreFromDelta` → `const { tree } = await restoreArtifact(checkpoint, guardedDeps, vectors);`.

- [ ] **Step 3: Fix all remaining call sites (tests + example) mechanically.** Add `await` (and `async` on the containing function) wherever `serializeArtifact`/`restoreArtifact`/`vectors.has`/`size`/`entries`/`search` are called. In the m11 packaging test, the embedded smoke-script SOURCE STRING also calls the storage round-trip — update that string too (it runs in a plain-Node fixture). Do NOT change any assertion values — only awaits/async.

- [ ] **Step 4: Full gate.** `npx vitest run` → 308 passing (same count — no new tests, no lost tests). `npm run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat!: async VectorIndexPort (+ async serialize/restoreArtifact) — unblocks DB-backed vector adapters"
```

---

### Task 2: Shared `isWithin` + honest scope error

**Files:**
- Modify: `src/jsonpointer.ts`, `src/errors.ts`, `src/mutator.ts`, `src/toolset.ts`, `src/navigator.ts`, `src/semantic-index.ts`
- Test: extend `test/m14-scoped-find.test.ts` is NOT needed; behavior is identical — this is deduplication. One new assertion for the message goes into `test/m15-toolset-returns.test.ts` (Task 3). No dedicated red test; the gate is the unchanged suite.

- [ ] **Step 1: Add to `src/jsonpointer.ts`:**

```ts
/** True when `path` is at or under `scope` (JSON Pointer prefix). Undefined scope = everywhere. */
export function isWithin(path: string, scope: string | undefined): boolean {
  return scope === undefined || path === scope || path.startsWith(scope + "/");
}
```

- [ ] **Step 2: `src/errors.ts`** — in `ScopeViolationError`, rename the `writeScope` field/param to `scope` and change the message to `` `Access outside scope: ${path} (scope: ${scope})` `` (keep the `code` unchanged). Fix any compile fallout (constructor call sites pass positionally — usually none).

- [ ] **Step 3: Replace the four inline prefix checks with `isWithin`:**
  - `src/mutator.ts` `checkScope`: body becomes `if (writeScope !== undefined && !isWithin(this.addressing.pathOf(node.id), writeScope)) throw new ScopeViolationError(path, writeScope);` (keep the single `pathOf` call in a local).
  - `src/toolset.ts`: delete the module-level `within()` helper; import `isWithin` from `./jsonpointer` and substitute at every use (describe/get/find/search/history + `eventWithinScope`).
  - `src/navigator.ts` `find`: the within check becomes `if (isWithin(path, within))` — note `isWithin` already treats undefined as pass, so the `within === undefined ||` prefix can be dropped.
  - `src/semantic-index.ts` `search`: the under-filter becomes `if (opts.under !== undefined && !isWithin(path, opts.under)) continue;`.

- [ ] **Step 4: Gate.** `npx vitest run` → 308 green (pure refactor; if any test asserted the old "Write outside scope" message text, update it — report which). `npm run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/jsonpointer.ts src/errors.ts src/mutator.ts src/toolset.ts src/navigator.ts src/semantic-index.ts
git commit -m "refactor!: single isWithin() scope helper; ScopeViolationError says Access (fires for reads too)"
```

---

### Task 3: Toolset returns — `PatchResult` and `FindResult`

**Files:**
- Modify: `src/toolset.ts`, `src/navigator.ts`
- Test: create `test/m15-toolset-returns.test.ts`; adapt existing consumers of `patch`/`find` return shapes (expected: m8 toolset tests, m14-move-guards `patch` assertions, m14-scoped-find + m14-capstone `find` assertions — values move under `.hits`).

- [ ] **Step 1: Write the failing test `test/m15-toolset-returns.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { makeToolset } from "../src/toolset";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function setup() {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson({ docs: {}, list: ["a", "b", "c", "d"] }, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0) });
  return { tree, addressing, log, mutator, ts: makeToolset({ tree, addressing, log, mutator }) };
}

describe("M15 patch returns id/path/version", () => {
  it("insert → the new node's id, path, and version", async () => {
    const s = setup();
    const r = await s.ts.patch({ path: "/docs" }, { op: "insert", key: "a", value: "v1" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.path).toBe("/docs/a");
      expect(r.value.id).toBe(s.addressing.byPath("/docs/a")!.id);
      expect(r.value.version).toBe(s.addressing.byPath("/docs/a")!.meta.version);
    }
  });

  it("set → the node's bumped version (usable as the next ifVersion)", async () => {
    const s = setup();
    await s.ts.patch({ path: "/docs" }, { op: "insert", key: "a", value: "v1" });
    const r1 = await s.ts.patch({ path: "/docs/a" }, { op: "set", value: "v2" });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    // optimistic-concurrency chaining without a follow-up get:
    const r2 = await s.ts.patch({ path: "/docs/a" }, { op: "set", value: "v3", ifVersion: r1.value.version });
    expect(r2.ok).toBe(true);
    const stale = await s.ts.patch({ path: "/docs/a" }, { op: "set", value: "v4", ifVersion: r1.value.version });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("STALE_VERSION");
  });

  it("move → the moved node at its NEW path; remove → removed id with the parent's version", async () => {
    const s = setup();
    await s.ts.patch({ path: "/docs" }, { op: "insert", key: "a", value: "v1" });
    const moved = await s.ts.patch({ path: "/docs/a" }, { op: "move", to: { path: "" }, key: "top" });
    if (moved.ok) expect(moved.value.path).toBe("/top");
    const removed = await s.ts.patch({ path: "/top" }, { op: "remove" });
    expect(removed.ok).toBe(true);
    if (removed.ok) {
      expect(removed.value.path).toBe("/top"); // the pre-removal path
      expect(removed.value.version).toBe(s.tree.root().meta.version); // parent's post-op version
    }
  });
});

describe("M15 find reports truncation", () => {
  it("truncated=true when the limit stopped the walk; false when exhausted", async () => {
    const s = setup();
    const t = await s.ts.find({ pathPattern: "/list/*" }, { limit: 2 });
    expect(t.ok).toBe(true);
    if (t.ok) {
      expect(t.value.hits.length).toBe(2);
      expect(t.value.truncated).toBe(true);
    }
    const all = await s.ts.find({ pathPattern: "/list/*" });
    if (all.ok) {
      expect(all.value.hits.length).toBe(4);
      expect(all.value.truncated).toBe(false);
    }
  });

  it("read-scope violation reports the honest Access message", async () => {
    const s = setup();
    const scoped = makeToolset(
      { tree: s.tree, addressing: s.addressing, log: s.log, mutator: s.mutator },
      { readScope: "/docs" },
    );
    const r = await scoped.get({ path: "/list" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SCOPE_VIOLATION");
      expect(r.error.message).toContain("Access outside scope");
    }
  });
});
```

Run: FAIL (patch returns `{}`/`{id}`, find returns an array, message says "Write").

- [ ] **Step 2: `src/navigator.ts`** — add `FindResult` and change `find`:

```ts
export interface FindResult {
  hits: FindHit[];
  /** True when the walk stopped at `limit` — there MAY be more matches (an exact-fit
   *  final hit also reports true). */
  truncated: boolean;
}
```

In `find`, change the return type to `FindResult`, add `let truncated = false;`, set `truncated = true` inside the two `hits.length >= limit` early-exit branches (the `return` at the top of `visit` and the `break` in the child loop), and `return { hits, truncated };`.

- [ ] **Step 3: `src/toolset.ts`** — add the result type + rewire `patch` and `find`:

```ts
export interface PatchResult {
  id: NodeId;
  path: string;
  /** The affected node's version AFTER the op (remove: the parent's). Feed into the next ifVersion. */
  version: number;
}
```

Update the `Toolset` interface: `find(...): Promise<ToolResult<FindResult>>;` (import `FindResult` from `./navigator`) and `patch(ref: Ref, op: PatchOp): Promise<ToolResult<PatchResult>>;`.

Replace the `patch` implementation:

```ts
    patch: (ref, op) =>
      run<PatchResult>(() => {
        const common = { owner: binding.owner, writeScope: binding.writeScope, ifVersion: op.ifVersion };
        const resolve = (r: Ref) => {
          const node = "id" in r ? addressing.byId(r.id) : addressing.byPath(r.path);
          if (!node) throw new NodeNotFoundError(r);
          return node;
        };
        switch (op.op) {
          case "set": {
            deps.mutator.set(ref, op.value, common);
            const node = resolve(ref);
            return { id: node.id, path: addressing.pathOf(node.id), version: node.meta.version };
          }
          case "insert": {
            const id = deps.mutator.insert(ref, op.key, op.value, common);
            const node = tree.get(id)!;
            return { id, path: addressing.pathOf(id), version: node.meta.version };
          }
          case "remove": {
            const node = resolve(ref);
            const removed = { id: node.id, path: addressing.pathOf(node.id) };
            const parentId = node.parentId;
            deps.mutator.remove(ref, common);
            const parent = parentId !== null ? tree.get(parentId) : undefined;
            return { id: removed.id, path: removed.path, version: parent?.meta.version ?? 0 };
          }
          case "move": {
            const node = resolve(ref);
            deps.mutator.move(ref, op.to, op.key, common);
            return { id: node.id, path: addressing.pathOf(node.id), version: node.meta.version };
          }
        }
      }),
```

(`find` needs no change beyond its signature — it already forwards `navigator.find`'s result, which is now a `FindResult`.)

- [ ] **Step 4: Adapt existing tests to the new shapes** (values only — no semantic changes): m8 toolset tests asserting `patch` value `{}`/`{id: ...}` → assert the id/path fields instead; every `find` consumer moves the array under `.hits` (`test/m14-scoped-find.test.ts`, `test/m14-capstone.test.ts` step 4, any m8 find tests, `test/toolset-search-find.test.ts`). List every adapted file in your report.

- [ ] **Step 5: Gate + commit.** `npx vitest run` → 308 prior-equivalents + 5 new = 313 green; `npm run typecheck` clean.

```bash
git add -A
git commit -m "feat!: patch returns {id,path,version}; find returns {hits,truncated} (no silent truncation)"
```

---

### Task 4: The `createArbor()` / `restoreArbor()` facade

**Files:**
- Create: `src/arbor.ts`
- Modify: `src/index.ts` (add `export * from "./arbor";` after the toolset export)
- Test: `test/m15-facade.test.ts`

- [ ] **Step 1: Write the failing test `test/m15-facade.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createArbor, restoreArbor } from "../src/arbor";
import { TypeRegistry } from "../src/type-registry";
import { zodValidate } from "../src/zod-adapter";
import { MockEmbeddingPort } from "../src/embedding-port";
import { MemoryStorage } from "../src/storage";
import { MemoryDeltaStorage } from "../src/delta-storage";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";
import { sizeBasedDecision } from "../src/decompose";

const testDeps = { idGen: () => new SeqIdGen(), clock: () => new FixedClock(0), decompose: () => sizeBasedDecision(1) };
function opts(extra: object = {}) {
  return { idGen: testDeps.idGen(), clock: testDeps.clock(), decompose: testDeps.decompose(), ...extra };
}

describe("M15 createArbor facade", () => {
  it("one call wires tree/mutator/toolset; agents work immediately", async () => {
    const arbor = createArbor(opts({ initial: { docs: {} } }));
    const agent = arbor.toolset({ owner: "w1", writeScope: "/docs", readScope: "/docs" });
    const w = await agent.patch({ path: "/docs" }, { op: "insert", key: "a", value: "hello" });
    expect(w.ok).toBe(true);
    const r = await agent.get({ path: "/docs/a" });
    expect(r.ok && r.value.content).toBe("hello");
    const esc = await agent.patch({ path: "" }, { op: "set", value: null });
    expect(esc.ok).toBe(false); // scope enforced through the facade
    expect(arbor.log.length()).toBe(1);
    expect(arbor.replay.getAt("/docs/a", 1)).toBe("hello");
  });

  it("registry wires validation AND type-aware decomposition", () => {
    const registry = new TypeRegistry();
    registry.register("doc", { validate: zodValidate(z.object({ body: z.string() })), decompose: "opaque" });
    const arbor = createArbor(opts({ registry, initial: { docs: {} } }));
    expect(() => arbor.mutator.insert({ path: "/docs" }, "bad", { body: 42 }, { type: "doc" })).toThrow();
    arbor.mutator.insert({ path: "/docs" }, "good", { body: "ok" }, { type: "doc" });
    expect(arbor.addressing.byPath("/docs/good")!.kind).toBe("leaf"); // decompose:"opaque" honored
  });

  it("embedding option wires the semantic index end-to-end", async () => {
    const arbor = createArbor(opts({ initial: { docs: {} }, embedding: new MockEmbeddingPort() }));
    arbor.mutator.insert({ path: "/docs" }, "a", "the quick brown fox");
    await arbor.index!.reindex();
    const hits = await arbor.index!.search("the quick brown fox");
    expect(hits.results[0]!.path).toBe("/docs/a");
  });

  it("save + restoreArbor round-trips (storage), search intact, and post-restore mutation is SAFE with a deterministic idGen", async () => {
    const storage = new MemoryStorage();
    const a1 = createArbor(opts({ initial: { docs: {} }, embedding: new MockEmbeddingPort(), storage }));
    a1.mutator.insert({ path: "/docs" }, "a", "persist me");
    await a1.index!.reindex();
    await a1.save();

    const a2 = await restoreArbor(opts({ embedding: new MockEmbeddingPort(), storage }));
    expect(a2).not.toBeNull();
    expect(a2!.tree.toJson()).toEqual({ docs: { a: "persist me" } });
    const hits = await a2!.index!.search("persist me");
    expect(hits.results[0]!.path).toBe("/docs/a");
    // known-minor (a): fresh SeqIdGen would mint colliding ids — the facade guards it
    a2!.mutator.insert({ path: "/docs" }, "b", "post-restore");
    expect(a2!.tree.toJson()).toEqual({ docs: { a: "persist me", b: "post-restore" } });
    expect(a2!.addressing.pathOf(a2!.addressing.byPath("/docs/b")!.id)).toBe("/docs/b"); // no cycle
  });

  it("delta lifecycle: saveDelta appends, checkpoint compacts+snapshots, restore prefers delta", async () => {
    const delta = new MemoryDeltaStorage();
    const a1 = createArbor(opts({ initial: { page: "" }, delta }));
    await a1.checkpoint(); // baseline snapshot @ v0
    for (let i = 1; i <= 10; i++) a1.mutator.set({ path: "/page" }, `v${i}`);
    await a1.saveDelta();
    expect((await delta.loadDelta()).journal.length).toBe(10);

    await a1.checkpoint({ keepLast: 3 }); // compact + snapshot, journal cleared
    const bundle = await delta.loadDelta();
    expect(bundle.checkpoint!.events.length).toBe(3);
    expect(bundle.journal.length).toBe(0);

    const a2 = await restoreArbor(opts({ delta }));
    expect(a2!.tree.toJson()).toEqual({ page: "v10" });
    expect(a2!.log.length()).toBe(10);
  });

  it("restoreArbor returns null when nothing was persisted; save without storage throws structured", async () => {
    expect(await restoreArbor(opts({ storage: new MemoryStorage() }))).toBeNull();
    const arbor = createArbor(opts());
    await expect(arbor.save()).rejects.toThrow();
  });
});
```

Run: FAIL — `../src/arbor` does not exist.

- [ ] **Step 2: Create `src/arbor.ts`**

```ts
import type { Json } from "./types";
import { ArtifactTree, type TreeDeps } from "./artifact-tree";
import { Addressing } from "./addressing";
import { EventLog } from "./event-log";
import { Mutator, type MutatorDeps } from "./mutator";
import { Replay } from "./replay";
import { SemanticIndex } from "./semantic-index";
import { makeToolset, type Toolset, type ToolsetBinding } from "./toolset";
import type { TypeRegistry } from "./type-registry";
import { makeRegistryValidator } from "./registry-validator";
import { typeAwareDecision } from "./type-aware-decision";
import { sizeBasedDecision, type DecomposeDecision } from "./decompose";
import { UuidIdGen, type IdGen } from "./ids";
import { SystemClock, type Clock } from "./clock";
import type { EmbeddingPort } from "./embedding-port";
import { MemoryVectorIndex, type VectorIndexPort } from "./vector-index-port";
import { serializeArtifact, restoreArtifact, type StoragePort } from "./storage";
import { persistCheckpoint, persistDelta, restoreFromDelta } from "./delta";
import type { DeltaStoragePort } from "./delta-storage";
import { InvalidOpError } from "./errors";

/** Everything `createArbor`/`restoreArbor` need. All optional — sensible defaults. */
export interface ArborOpts {
  /** Initial JSON for a fresh artifact (default {}). Ignored by restoreArbor. */
  initial?: Json;
  /** Node types: per-type validation, decompose override, embedText. */
  registry?: TypeRegistry;
  /** Base decompose policy (default sizeBasedDecision(200)); made type-aware when a registry is given. */
  decompose?: DecomposeDecision;
  idGen?: IdGen; // default UuidIdGen — deterministic gens are safe too (restore is guarded)
  clock?: Clock; // default SystemClock
  /** Enables the semantic index (vectors default to MemoryVectorIndex). */
  embedding?: EmbeddingPort;
  vectors?: VectorIndexPort;
  /** Whole-artifact persistence: enables save(); restoreArbor falls back to it. */
  storage?: StoragePort;
  /** Incremental persistence: enables saveDelta()/checkpoint(); restoreArbor prefers it. */
  delta?: DeltaStoragePort;
}

/** A fully wired artifact: the live components plus lifecycle helpers. */
export interface Arbor {
  readonly tree: ArtifactTree;
  readonly addressing: Addressing;
  readonly log: EventLog;
  readonly mutator: Mutator;
  readonly replay: Replay;
  /** Present iff `embedding` was configured. */
  readonly index?: SemanticIndex;
  readonly vectors: VectorIndexPort;
  /** A scoped agent-facing toolset over this artifact. */
  toolset(binding?: ToolsetBinding): Toolset;
  /** Whole-artifact snapshot to `storage`. */
  save(): Promise<void>;
  /** Append events since the last saveDelta/checkpoint to the delta journal. */
  saveDelta(): Promise<void>;
  /** Full snapshot to delta storage (clears the journal). `keepLast` first compacts
   *  the log to a sliding window of that many events. */
  checkpoint(opts?: { keepLast?: number }): Promise<void>;
}

function buildDeps(opts: ArborOpts): TreeDeps {
  const base = opts.decompose ?? sizeBasedDecision(200);
  return {
    idGen: opts.idGen ?? new UuidIdGen(),
    clock: opts.clock ?? new SystemClock(),
    decision: opts.registry ? typeAwareDecision(base, opts.registry) : base,
  };
}

/** Wrap an idGen so it never mints an id already present in `used` (and records
 *  what it mints) — restoring preserves stored node ids, so a deterministic
 *  generator would otherwise collide and corrupt the node map. */
function guardIdGen(idGen: IdGen, used: Set<string>): IdGen {
  return {
    next: () => {
      let id = idGen.next();
      while (used.has(id)) id = idGen.next();
      used.add(id);
      return id;
    },
  };
}

function assemble(
  opts: ArborOpts,
  tree: ArtifactTree,
  log: EventLog,
  vectors: VectorIndexPort,
  clock: Clock,
): Arbor {
  const addressing = new Addressing(tree);
  const index = opts.embedding
    ? new SemanticIndex(tree, addressing, opts.embedding, vectors, opts.registry)
    : undefined;
  const mdeps: MutatorDeps = { clock };
  if (opts.registry) mdeps.validate = makeRegistryValidator(opts.registry);
  if (index) Object.assign(mdeps, index.hooks());
  const mutator = new Mutator(tree, addressing, log, mdeps);
  const replay = new Replay(tree, log);
  let highWater = log.length(); // delta journal position (everything before is persisted/checkpointed)

  return {
    tree,
    addressing,
    log,
    mutator,
    replay,
    index,
    vectors,
    toolset: (binding) => makeToolset({ tree, addressing, log, mutator, index }, binding),
    save: async () => {
      if (!opts.storage) throw new InvalidOpError("save(): no storage configured");
      await opts.storage.save(await serializeArtifact(tree, log, vectors));
    },
    saveDelta: async () => {
      if (!opts.delta) throw new InvalidOpError("saveDelta(): no delta storage configured");
      highWater = await persistDelta(opts.delta, log, highWater);
    },
    checkpoint: async (o) => {
      if (!opts.delta) throw new InvalidOpError("checkpoint(): no delta storage configured");
      if (o?.keepLast !== undefined) log.compactTo(log.length() - o.keepLast);
      highWater = await persistCheckpoint(opts.delta, tree, log, vectors);
    },
  };
}

/** Build a fresh, fully wired artifact from `opts.initial` (default {}). */
export function createArbor(opts: ArborOpts = {}): Arbor {
  const deps = buildDeps(opts);
  const tree = ArtifactTree.fromJson(opts.initial ?? {}, deps);
  const log = new EventLog();
  const vectors = opts.vectors ?? new MemoryVectorIndex();
  return assemble(opts, tree, log, vectors, deps.clock);
}

/**
 * Restore a fully wired artifact from persistence: prefers `delta` (checkpoint +
 * forward-replayed journal), falls back to `storage`, returns null when neither has
 * data. Owns the restore invariants: a fresh (or caller-provided) vector index is
 * upserted from the snapshot, the SemanticIndex is re-created (it re-seeds its stale
 * queue from node meta), and the idGen is guarded against collisions with restored
 * node ids. Use the SAME `decompose`/`registry` as the original run — journal-touched
 * nodes are re-decomposed on delta restore.
 */
export async function restoreArbor(opts: ArborOpts): Promise<Arbor | null> {
  const deps = buildDeps(opts);
  const vectors = opts.vectors ?? new MemoryVectorIndex();
  if (opts.delta) {
    const restored = await restoreFromDelta(opts.delta, deps, vectors); // guards its idGen internally
    if (restored) return assemble(opts, restored.tree, restored.log, vectors, deps.clock);
  }
  if (opts.storage) {
    const stored = await opts.storage.load();
    if (stored) {
      const guarded: TreeDeps = {
        ...deps,
        idGen: guardIdGen(deps.idGen, new Set(stored.nodes.map((n) => n.id))),
      };
      const { tree, log } = await restoreArtifact(stored, guarded, vectors);
      return assemble(opts, tree, log, vectors, deps.clock);
    }
  }
  return null;
}
```

- [ ] **Step 3: Barrel.** In `src/index.ts`, add `export * from "./arbor";` after the `export * from "./toolset";` line.

- [ ] **Step 4: Gate.** `npx vitest run test/m15-facade.test.ts` → PASS (6 tests). Then full `npx vitest run` (313 + 6 = 319) and `npm run typecheck` clean. NOTE: if `SystemClock` is named differently in `src/clock.ts`, use the actual exported production clock (check the file) and report the substitution.

- [ ] **Step 5: Commit**

```bash
git add src/arbor.ts src/index.ts test/m15-facade.test.ts
git commit -m "feat: createArbor/restoreArbor facade — one-call wiring + safe restore (guarded idGen, fresh index)"
```

---

### Task 5: Capstone — the README-quickstart shape works end-to-end

**Files:**
- Test: `test/m15-capstone.test.ts`

- [ ] **Step 1: Write `test/m15-capstone.test.ts`** (should pass immediately — it is the facade + M14 guarantees composed; if it fails, fix the owning task's source, not the test):

```ts
import { describe, it, expect } from "vitest";
import { createArbor, restoreArbor } from "../src/arbor";
import { MockEmbeddingPort } from "../src/embedding-port";
import { MemoryDeltaStorage } from "../src/delta-storage";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";
import { sizeBasedDecision } from "../src/decompose";

describe("M15 capstone: facade lifecycle under agent traffic", () => {
  it("create → scoped agents write → delta persist → restore → history + search survive", async () => {
    const delta = new MemoryDeltaStorage();
    const mk = () => ({
      idGen: new SeqIdGen(),
      clock: new FixedClock(0),
      decompose: sizeBasedDecision(1),
      embedding: new MockEmbeddingPort(),
      delta,
    });

    const run1 = createArbor({ ...mk(), initial: { pages: {}, plan: "" } });
    await run1.checkpoint();
    const writer = run1.toolset({ owner: "writer", writeScope: "/pages", readScope: "/pages" });
    const w1 = await writer.patch({ path: "/pages" }, { op: "insert", key: "home", value: "welcome home page" });
    expect(w1.ok).toBe(true);
    const w2 = await writer.patch({ path: "/plan" }, { op: "set", value: "hacked" });
    expect(w2.ok).toBe(false); // scope holds through the facade
    await run1.index!.reindex();
    await run1.saveDelta();

    const run2 = await restoreArbor(mk());
    expect(run2).not.toBeNull();
    expect(run2!.tree.toJson()).toEqual({ pages: { home: "welcome home page" }, plan: "" });
    await run2!.index!.reindex(); // delta-restored stale nodes re-embed (M14 fix)
    const found = await run2!.index!.search("welcome home page");
    expect(found.results[0]!.path).toBe("/pages/home");
    expect(found.staleCount).toBe(0);
    expect(run2!.replay.getAt("/pages/home", run2!.log.length())).toBe("welcome home page");
    // post-restore mutation with the deterministic gen is safe (facade guard)
    run2!.mutator.insert({ path: "/pages" }, "about", "about us");
    expect(run2!.addressing.pathOf(run2!.addressing.byPath("/pages/about")!.id)).toBe("/pages/about");
  });
});
```

- [ ] **Step 2: Gate.** `npx vitest run test/m15-capstone.test.ts` → PASS. Then `npm test && npm run typecheck && npm run build` all green (build must include `dist/arbor.js` + `.d.ts`).

- [ ] **Step 3: Commit**

```bash
git add test/m15-capstone.test.ts
git commit -m "test: M15 capstone — facade lifecycle (scoped agents, delta persist, guarded restore, search)"
```

---

## Milestone 15 — Definition of Done

- [ ] `npm test` all green (~320), `npm run typecheck` clean, `npm run build` green with the new `arbor` module in dist.
- [ ] `VectorIndexPort` fully async; `serializeArtifact`/`restoreArtifact` async; Memory impl behavior unchanged.
- [ ] One `isWithin` used by mutator/toolset/navigator/semantic-index; `ScopeViolationError` says "Access outside scope" with a `scope` field.
- [ ] `patch` → `{id, path, version}` (chainable ifVersion, proven by test); `find` → `{hits, truncated}`.
- [ ] `createArbor` wires registry validation + type-aware decomposition + semantic index hooks in one call; `restoreArbor` prefers delta, falls back to storage, returns null when empty, and post-restore mutation with a deterministic idGen is safe (known-minor (a) closed at the facade AND storage path).
- [ ] Capstone: full lifecycle (scoped agents → delta persist → restore → reindex → search/history) through the facade only.

## Roadmap: next

- **M16 — publish packaging:** rename to `arborkit` (npm name verified free 2026-07-03), package.json metadata (description/keywords/license/author), explicit exports (no chunk leakage — disable splitting or enumerate), LICENSE (MIT), CHANGELOG seeded from milestone history, minimal GitHub Actions CI, README quickstart rewritten against `createArbor` with package-name imports + StoredArtifact v1/v2 migration note, m11 packaging test updated to install/import `arborkit`, flip `private`.
- **Downstream follow-up:** adapt `content-generator-arbor` (async port + toolset return shapes; its tsconfig alias into `src/` breaks at M15 until then).
- Later (P2): perf wins (replay clone-once, byPath child map, glob), typed-ancestor staleness + move hooks, AG-UI adapter.

## Self-Review

**Spec coverage:** all five P1-part-1 items map to Tasks 1–4 + capstone; the dropped Ref move is stated with its reason; known-minor (a) is closed by Task 4's guard + test.
**Placeholder scan:** none — Task 1 is an explicitly compiler-driven migration with named call sites; all other code steps carry complete code; conditional substitutions (SystemClock name, old message text in tests) name the exact check and require reporting.
**Type consistency:** `VectorIndexPort` async signatures match every rewritten call site listed in Task 1 (`await` on remove/upsert/search/size/entries). `isWithin(path, scope?)` matches all four substitution sites. `PatchResult`/`FindResult` consumed by the updated `Toolset` interface; `NodeNotFoundError`/`addressing`/`tree` are already in toolset scope (imported/destructured). Facade: `TypeRegistry` (class) imported as type-only is fine (only used as a type); `typeAwareDecision(base, registry)` argument order per type-aware-decision.ts; `makeRegistryValidator(registry)` → `Validator` matches `MutatorDeps.validate`; `SemanticIndex(tree, addressing, embedding, vectors, registry?)` per its ctor; `persistDelta/persistCheckpoint/restoreFromDelta` signatures per delta.ts (M13); `UuidIdGen`/`SeqIdGen` per ids.ts; `MockEmbeddingPort` has `dims` built in; `sizeBasedDecision(200)` default documented. Facade tests use `sizeBasedDecision(1)` (fixture gotcha) and deterministic `SeqIdGen`+`FixedClock` everywhere.
