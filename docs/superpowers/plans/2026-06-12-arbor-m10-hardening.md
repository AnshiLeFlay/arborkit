# Arbor — M10: Hardening Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the issues found by the post-v1 adversarial review — three critical semantic-index lifecycle bugs (C1 decomposed children never indexed, C2 stale set lost on restore, C3 transaction not atomic over the index), the reference leak at the toolset boundary (I1), non-atomic/unvalidated file storage, and the type-blind `Replay.revert` — plus pin the `ifVersion`-on-insert semantics and make the README honest about scope.

**Architecture:** The three criticals share one root cause: the semantic index's state (the `stale` set + node `meta.embedding`) lives outside the snapshot/persist/transaction boundaries the rest of the library maintains. The fixes pull it inside: (C2) the `SemanticIndex` constructor seeds its stale set from persisted `meta.embedding.state` so restore round-trips it; (C1) the `Mutator` fires `onChange` for every NEW descendant a `set`/`insert` creates (symmetric with the M6 orphan-`onRemove` fix); (C3) `MutatorDeps` gains optional `onTxSnapshot`/`onTxRestore` hooks that `transaction` calls, and `SemanticIndex.hooks()` provides them. Separately: `Toolset.get` deep-clones the whole result (I1); `FileStorage` writes tmp+rename and validates shape on load; `MutationEvent` records node types so `Replay.revert` restores the type as of the target version (with an explicit `type: null` clear affordance in `MutateOpts`/`replaceValue`).

**Tech Stack:** Node ≥20.6, TypeScript (ESM, strict), Vitest. No new dependencies. Builds on M1–M9 (219 tests).

---

## Scope of THIS plan (Milestone 10)

The correctness-hardening backlog from the 2026-06-12 adversarial review. Each task is independently shippable. Produces: a library whose semantic index survives decomposition, restore, and failed transactions; whose toolset cannot be bypassed by mutating read values; whose file storage is crash-safe; and whose revert is type-aware (removing the downstream `ArborRun.revertArtifact` workaround need).

**Out of scope (next milestones, listed in Roadmap):** packaging (barrel + build + `exports` — M11), log compaction/checkpointing + delta persistence + atomic-rename for big artifacts' performance (M12), tag/type indexes for `find`, `stats()`/`subscribe`, ANN vector adapters. Changing `ifVersion`-on-insert *behavior* (we pin + document the parent-scoped semantics instead; a per-node design is a future fork if a consumer needs it).

## Design decisions (locked for M10)

1. **C2 fix is constructor-automatic.** `SemanticIndex`'s constructor scans `tree.allNodes()` and seeds `stale` with every node whose `meta.embedding.state === "stale"`. A fresh tree has only `"none"` states → no-op; a restored tree recovers its queue with no API change and no consumer change.
2. **C1 fix lives in the Mutator,** not the index: after `replaceValue`/`insertChild`, fire `onChange` for the target AND each `descendantIds(target)` node (they are all newly built). This mirrors the M6 orphan fix (remove/set fire `onRemove` for all deleted descendants) — the hook surface becomes symmetric. Containers among the descendants get marked `"none"` by the index (their `toEmbeddingText` is null) — harmless; text leaves get marked stale — the fix.
3. **C3 fix is hook-shaped** to keep the Mutator decoupled from the index: `MutatorDeps` gains `onTxSnapshot?: () => unknown` and `onTxRestore?: (snapshot: unknown) => void`; `transaction` captures the snapshot before `fn()` and restores it on throw. `SemanticIndex.hooks()` now returns all four hooks, so the existing `{ clock, ...index.hooks() }` wiring picks them up with zero consumer change. Vectors need no snapshot: `transaction(fn)` takes a **synchronous** `fn`, and all vector writes happen in the async `reindex()` — they cannot interleave a sync transaction (documented as an invariant).
4. **I1 fix:** `Toolset.get` returns `structuredClone(r)` — the whole `GetResult` (content + meta), not just meta. The in-process `Navigator.get` keeps returning live references (documented; cloning there would tax non-boundary callers).
5. **Type-aware revert encoding:** `MutationEvent` gains `nodeTypeBefore?: string | null` and `nodeType?: string | null` — `null` means "explicitly untyped", **absent** means "pre-M10 event (unknown)". `Replay.typeAt(path, version)` returns `string` (had that type) | `null` (untyped/absent at that version) | `undefined` (unknown or unchanged → keep current behavior). `MutateOpts.type` widens to `string | null` where `null` clears the node's type (`replaceValue` gains a `clearType` flag); validation treats a cleared type as no-type (validator skips). Old persisted logs keep their old revert behavior (absent fields → `undefined` → type untouched).
6. **`ifVersion` on insert stays parent-scoped** (it IS a CAS on the container — every sibling insert bumps the parent). M10 pins it with a test and documents it instead of changing it.

## File structure (Milestone 10)

- Modify: `src/semantic-index.ts` — constructor stale-seeding (C2); `txSnapshot`/`txRestore` + extended `hooks()` (C3).
- Modify: `src/mutator.ts` — descendant `onChange` in `set`/`insert` (C1); `onTxSnapshot`/`onTxRestore` in `MutatorDeps` + `transaction` (C3); `MutateOpts.type: string | null` + type recording on events (Task 6).
- Modify: `src/toolset.ts` — `get` deep-clones the result (I1).
- Modify: `src/file-storage.ts` — atomic save (tmp+rename) + validated load.
- Modify: `src/event-log.ts` — `nodeTypeBefore?`/`nodeType?` on `MutationEvent`.
- Modify: `src/artifact-tree.ts` — `replaceValue` gains `clearType` param.
- Modify: `src/replay.ts` — `typeAt` + type-aware `revert`.
- Modify: `README.md` — "Scope & limits" section.
- Test: `test/m10-stale-restore.test.ts`, `test/m10-decomposed-children.test.ts`, `test/m10-tx-index.test.ts`, `test/m10-toolset-clone.test.ts`, `test/m10-file-storage-atomic.test.ts`, `test/m10-type-aware-revert.test.ts`, `test/m10-hardening.test.ts` (capstone + ifVersion pin).

---

### Task 1: C2 — SemanticIndex seeds its stale set from persisted meta

**Files:**
- Modify: `src/semantic-index.ts` (constructor only)
- Test: `test/m10-stale-restore.test.ts`

- [ ] **Step 1: Write the failing test `test/m10-stale-restore.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { SemanticIndex } from "../src/semantic-index";
import { MockEmbeddingPort } from "../src/embedding-port";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { serializeArtifact, restoreArtifact, MemoryStorage } from "../src/storage";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function freshDeps(): TreeDeps {
  return { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
}

describe("M10 C2: stale state survives persist→restore", () => {
  it("a node persisted while stale is re-queued and searchable after restore + reindex", async () => {
    const tree = ArtifactTree.fromJson({ docs: {} }, freshDeps());
    const addressing = new Addressing(tree);
    const log = new EventLog();
    const vectors = new MemoryVectorIndex();
    const index = new SemanticIndex(tree, addressing, new MockEmbeddingPort(), vectors);
    const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0), ...index.hooks() });

    mutator.insert({ path: "/docs" }, "a", "the quick brown fox");
    expect(index.staleCount()).toBe(1); // stale, NOT reindexed — the normal mid-run state

    const store = new MemoryStorage();
    await store.save(serializeArtifact(tree, log, vectors)); // persisted while stale

    const loaded = (await store.load())!;
    const freshVectors = new MemoryVectorIndex();
    const { tree: rtree } = restoreArtifact(loaded, freshDeps(), freshVectors);
    const rindex = new SemanticIndex(rtree, new Addressing(rtree), new MockEmbeddingPort(), freshVectors);

    expect(rindex.staleCount()).toBe(1); // FIX: seeded from meta.embedding.state
    await rindex.reindex();
    const r = await rindex.search("the quick brown fox");
    expect(r.results[0]?.path).toBe("/docs/a");
    expect(r.staleCount).toBe(0);
  });

  it("a fresh (non-restored) tree seeds nothing", () => {
    const tree = ArtifactTree.fromJson({ a: "x" }, freshDeps());
    const index = new SemanticIndex(tree, new Addressing(tree), new MockEmbeddingPort(), new MemoryVectorIndex());
    expect(index.staleCount()).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/m10-stale-restore.test.ts`
Expected: FAIL — `rindex.staleCount()` is `0` (stale set starts empty), search finds nothing.

- [ ] **Step 3: Modify `src/semantic-index.ts`** — give the constructor a body that seeds from meta (replace the current empty-body constructor at lines 38–44):

```ts
  constructor(
    private readonly tree: ArtifactTree,
    private readonly addressing: Addressing,
    private readonly embedding: EmbeddingPort,
    private readonly vectors: VectorIndexPort,
    private readonly registry?: TypeRegistry,
  ) {
    // Recover the stale queue after a restore: `stale` itself is not persisted,
    // but each node's `meta.embedding.state` is. A fresh tree has only "none"
    // states, so this is a no-op there.
    for (const node of tree.allNodes()) {
      if (node.meta.embedding.state === "stale") this.stale.add(node.id);
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/m10-stale-restore.test.ts`
Expected: PASS (2 tests). Then `npx vitest run` — no regressions.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (clean), then:

```bash
git add src/semantic-index.ts test/m10-stale-restore.test.ts
git commit -m "fix: SemanticIndex seeds stale set from persisted meta (stale state survives restore)"
```

---

### Task 2: C1 — set/insert fire onChange for newly-built descendants

**Files:**
- Modify: `src/mutator.ts` (`set` + `insert` only)
- Test: `test/m10-decomposed-children.test.ts`

- [ ] **Step 1: Write the failing test `test/m10-decomposed-children.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { SemanticIndex } from "../src/semantic-index";
import { MockEmbeddingPort } from "../src/embedding-port";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function setup() {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson({ docs: {} }, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const index = new SemanticIndex(tree, addressing, new MockEmbeddingPort(), new MemoryVectorIndex());
  const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0), ...index.hooks() });
  return { tree, addressing, index, mutator };
}

describe("M10 C1: decomposed children get indexed", () => {
  it("inserting a decomposing container makes its text-leaf children searchable", async () => {
    const { index, mutator } = setup();
    // threshold 1 → this object decomposes into child nodes; the strings are the leaves
    mutator.insert({ path: "/docs" }, "page", { title: "alpha beta", body: "gamma delta" });
    expect(index.staleCount()).toBeGreaterThanOrEqual(2); // both text leaves queued
    await index.reindex();
    const r = await index.search("alpha beta");
    expect(r.results.some((h) => h.path === "/docs/page/title")).toBe(true);
  });

  it("a set that re-decomposes also queues the NEW children", async () => {
    const { index, mutator } = setup();
    mutator.insert({ path: "/docs" }, "page", { title: "first" });
    await index.reindex();
    mutator.set({ path: "/docs/page" }, { title: "second wind", extra: "more text here" });
    expect(index.staleCount()).toBeGreaterThanOrEqual(2);
    await index.reindex();
    const r = await index.search("second wind");
    expect(r.results.some((h) => h.path === "/docs/page/title")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/m10-decomposed-children.test.ts`
Expected: FAIL — `staleCount()` is 0 (only the container got `onChange`; its embedText is null).

- [ ] **Step 3: Modify `src/mutator.ts`.** In `set`, after `this.deps.onChange?.(node);` (currently line 77) add the descendant loop, so the hook block reads:

```ts
    this.deps.onChange?.(node);
    if (this.deps.onChange) {
      // replaceValue rebuilt the subtree: every descendant is a NEW node and
      // must be announced too (text leaves are what the semantic index embeds).
      for (const id of this.tree.descendantIds(node.id)) {
        const child = this.tree.get(id);
        if (child) this.deps.onChange(child);
      }
    }
    if (this.deps.onRemove) {
      for (const id of orphaned) this.deps.onRemove(id);
    }
```

In `insert`, after `this.deps.onChange?.(child);` (currently line 103) add:

```ts
    this.deps.onChange?.(child);
    if (this.deps.onChange) {
      for (const id of this.tree.descendantIds(newId)) {
        const desc = this.tree.get(id);
        if (desc) this.deps.onChange(desc);
      }
    }
```

(Do NOT touch `remove`/`move`/`transaction`/guards.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/m10-decomposed-children.test.ts`
Expected: PASS (2 tests). Then `npx vitest run` — no regressions (existing M5/M9 suites use opaque values: `descendantIds` is empty there, behavior unchanged).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (clean), then:

```bash
git add src/mutator.ts test/m10-decomposed-children.test.ts
git commit -m "fix: set/insert fire onChange for newly-built descendants (decomposed children get indexed)"
```

---

### Task 3: C3 — transaction covers the semantic-index state

**Files:**
- Modify: `src/mutator.ts` (`MutatorDeps` + `transaction`)
- Modify: `src/semantic-index.ts` (`txSnapshot`/`txRestore` + `hooks()`)
- Test: `test/m10-tx-index.test.ts`

- [ ] **Step 1: Write the failing test `test/m10-tx-index.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { SemanticIndex } from "../src/semantic-index";
import { MockEmbeddingPort } from "../src/embedding-port";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function setup() {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson({ docs: {} }, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const index = new SemanticIndex(tree, addressing, new MockEmbeddingPort(), new MemoryVectorIndex());
  const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0), ...index.hooks() });
  return { tree, index, mutator };
}

describe("M10 C3: transaction rollback restores the stale set", () => {
  it("a failed transaction leaves staleCount exactly as before", () => {
    const { index, mutator } = setup();
    mutator.insert({ path: "/docs" }, "keep", "existing text");
    const before = index.staleCount(); // 1
    expect(() =>
      mutator.transaction(() => {
        mutator.insert({ path: "/docs" }, "doomed", "rolled back text");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(index.staleCount()).toBe(before); // no ghost stale entry for the rolled-back node
  });

  it("a successful transaction keeps its stale marks", () => {
    const { index, mutator } = setup();
    mutator.transaction(() => {
      mutator.insert({ path: "/docs" }, "a", "text one");
      mutator.insert({ path: "/docs" }, "b", "text two");
    });
    expect(index.staleCount()).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/m10-tx-index.test.ts`
Expected: FAIL — first test sees `staleCount === before + 1` (ghost entry survives rollback).

- [ ] **Step 3: Modify `src/semantic-index.ts`.** Add two methods after `hooks()` and extend `hooks()`:

```ts
  /** Snapshot of the stale queue for transaction rollback (vectors never change
   *  inside a transaction: `transaction(fn)` is synchronous and all vector writes
   *  happen in the async `reindex()`). */
  txSnapshot(): unknown {
    return new Set(this.stale);
  }

  /** Restore the stale queue captured by `txSnapshot`. */
  txRestore(snapshot: unknown): void {
    this.stale.clear();
    for (const id of snapshot as Set<NodeId>) this.stale.add(id);
  }

  /** Convenience: the hooks to wire into `MutatorDeps`. */
  hooks(): {
    onChange: (node: ArbNode) => void;
    onRemove: (nodeId: NodeId) => void;
    onTxSnapshot: () => unknown;
    onTxRestore: (snapshot: unknown) => void;
  } {
    return {
      onChange: (node) => this.onChange(node),
      onRemove: (nodeId) => this.onRemove(nodeId),
      onTxSnapshot: () => this.txSnapshot(),
      onTxRestore: (snapshot) => this.txRestore(snapshot),
    };
  }
```

(Replace the existing `hooks()`; keep `onChange`/`onRemove` themselves untouched.)

- [ ] **Step 4: Modify `src/mutator.ts`.** Add to `MutatorDeps` (after `onRemove?`):

```ts
  /** Called at transaction start; the returned snapshot is passed to `onTxRestore` on rollback. */
  onTxSnapshot?: () => unknown;
  /** Called on transaction rollback with the snapshot from `onTxSnapshot`. */
  onTxRestore?: (snapshot: unknown) => void;
```

Replace `transaction` with:

```ts
  /** Run `fn` atomically: if it throws, the tree, log, and any hooked index state are restored. */
  transaction(fn: () => void): void {
    const snap = this.tree.snapshot();
    const logLen = this.log.length();
    const hookSnap = this.deps.onTxSnapshot?.();
    try {
      fn();
    } catch (err) {
      this.tree.restore(snap);
      this.log.truncateTo(logLen);
      if (this.deps.onTxRestore) this.deps.onTxRestore(hookSnap);
      throw err;
    }
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/m10-tx-index.test.ts`
Expected: PASS (2 tests). Then `npx vitest run` — no regressions (the new hooks are optional; existing wiring `...index.hooks()` picks them up automatically).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck` (clean), then:

```bash
git add src/mutator.ts src/semantic-index.ts test/m10-tx-index.test.ts
git commit -m "fix: transaction rollback restores semantic-index stale state (onTxSnapshot/onTxRestore hooks)"
```

---

### Task 4: I1 — Toolset.get returns a deep clone (no live references across the boundary)

**Files:**
- Modify: `src/toolset.ts` (`get` only)
- Test: `test/m10-toolset-clone.test.ts`

- [ ] **Step 1: Write the failing test `test/m10-toolset-clone.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { makeToolset } from "../src/toolset";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { SystemClock } from "../src/clock";

describe("M10 I1: toolset.get returns no live references", () => {
  it("mutating the returned content does not change the tree and logs no event", async () => {
    const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new SystemClock(), decision: sizeBasedDecision(1) };
    const tree = ArtifactTree.fromJson({ pages: {} }, deps);
    const addressing = new Addressing(tree);
    const log = new EventLog();
    const mutator = new Mutator(tree, addressing, log, { clock: deps.clock });
    const tools = makeToolset({ tree, addressing, log, mutator }, { writeScope: "/pages" });

    await tools.patch({ path: "/pages" }, { op: "insert", key: "home", value: { title: "Home" } });
    const logLenBefore = log.length();

    const got = await tools.get({ path: "/pages/home" });
    expect(got.ok).toBe(true);
    if (got.ok) {
      (got.value.content as Record<string, unknown>)["injected"] = "HACKED";
      got.value.meta.version = 999;
    }

    expect(tree.toJson()).toEqual({ pages: { home: { title: "Home" } } }); // tree untouched
    expect(log.length()).toBe(logLenBefore); // no event sneaked in
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/m10-toolset-clone.test.ts`
Expected: FAIL — `tree.toJson()` contains `injected: "HACKED"` (content was a live reference).

- [ ] **Step 3: Modify `src/toolset.ts`.** In `get` (currently lines 94–101), replace the return with a full clone:

```ts
    get: (ref, opts) =>
      run(() => {
        const r = navigator.get(ref, opts);
        if (!within(r.path, binding.readScope)) {
          throw new ScopeViolationError(r.path, binding.readScope!);
        }
        // Deep-clone the WHOLE result: `content` (and `meta`) come from the live
        // tree by reference; handing them across the agent boundary would let a
        // caller mutate the artifact without an event, bypassing write-scope.
        return structuredClone(r);
      }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/m10-toolset-clone.test.ts`
Expected: PASS. Then `npx vitest run` — no regressions (the M8 meta-clone test still passes: cloning more is a superset).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (clean), then:

```bash
git add src/toolset.ts test/m10-toolset-clone.test.ts
git commit -m "fix: Toolset.get deep-clones the whole result (no live content reference across the boundary)"
```

---

### Task 5: Atomic + validated FileStorage

**Files:**
- Modify: `src/file-storage.ts`
- Test: `test/m10-file-storage-atomic.test.ts`

- [ ] **Step 1: Write the failing test `test/m10-file-storage-atomic.test.ts`**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { rm, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { FileStorage } from "../src/file-storage";
import type { StoredArtifact } from "../src/storage";

const dir = mkdtempSync(join(tmpdir(), "arbor-m10-fs-"));
const path = join(dir, "artifact.json");

function sample(): StoredArtifact {
  return {
    version: 1,
    rootId: "n0",
    nodes: [
      { id: "n0", parentId: null, key: null, kind: "leaf", content: "x", childIds: [], meta: { version: 0, updatedAt: 0, embedding: { state: "none" } } },
    ],
    events: [],
    vectors: [],
  };
}

describe("M10: FileStorage atomic save + validated load", () => {
  afterEach(async () => {
    await rm(path, { force: true });
    await rm(path + ".tmp", { force: true });
  });

  it("save leaves no .tmp file behind and round-trips", async () => {
    const store = new FileStorage(path);
    await store.save(sample());
    const names = await readdir(dir);
    expect(names).toContain("artifact.json");
    expect(names.some((n) => n.endsWith(".tmp"))).toBe(false);
    expect(await store.load()).toEqual(sample());
  });

  it("load of corrupt JSON throws a clear error (not a bare SyntaxError pass-through into restore)", async () => {
    await writeFile(path, "{ this is not json", "utf8");
    await expect(new FileStorage(path).load()).rejects.toThrow(/FileStorage: corrupt/);
  });

  it("load of valid JSON with the wrong shape throws a clear error", async () => {
    await writeFile(path, JSON.stringify({ hello: "world" }), "utf8");
    await expect(new FileStorage(path).load()).rejects.toThrow(/FileStorage: invalid/);
  });

  it("missing file still returns null", async () => {
    expect(await new FileStorage(join(dir, "absent.json")).load()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/m10-file-storage-atomic.test.ts`
Expected: FAIL — corrupt JSON rejects with a bare `SyntaxError` (no "FileStorage:" prefix); wrong shape loads silently.

- [ ] **Step 3: Rewrite `src/file-storage.ts`:**

```ts
import { readFile, writeFile, rename } from "node:fs/promises";
import type { StoredArtifact, StoragePort } from "./storage";

function isStoredArtifact(v: unknown): v is StoredArtifact {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    a["version"] === 1 &&
    typeof a["rootId"] === "string" &&
    Array.isArray(a["nodes"]) &&
    Array.isArray(a["events"]) &&
    Array.isArray(a["vectors"])
  );
}

/**
 * File-backed StoragePort: one JSON file per artifact. `load` returns null if the
 * file is absent. Saves are atomic (write tmp, then rename) so a crash mid-write
 * never corrupts an existing artifact; loads validate the parsed shape.
 */
export class FileStorage implements StoragePort {
  constructor(private readonly path: string) {}

  async save(artifact: StoredArtifact): Promise<void> {
    const tmp = this.path + ".tmp";
    await writeFile(tmp, JSON.stringify(artifact), "utf8");
    await rename(tmp, this.path);
  }

  async load(): Promise<StoredArtifact | null> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`FileStorage: corrupt artifact file ${this.path}: ${detail}`);
    }
    if (!isStoredArtifact(parsed)) {
      throw new Error(`FileStorage: invalid artifact file ${this.path} (unrecognized shape)`);
    }
    return parsed;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/m10-file-storage-atomic.test.ts`
Expected: PASS (4 tests). Then `npx vitest run` — no regressions (M6 round-trip tests unaffected; `rename` overwrites the destination atomically on the same volume).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (clean), then:

```bash
git add src/file-storage.ts test/m10-file-storage-atomic.test.ts
git commit -m "fix: FileStorage atomic save (tmp+rename) + validated load with clear errors"
```

---

### Task 6: Type-aware revert (events record node types; revert restores the type as of the version)

**Files:**
- Modify: `src/event-log.ts` (`MutationEvent` + 2 fields)
- Modify: `src/artifact-tree.ts` (`replaceValue` gains `clearType`)
- Modify: `src/mutator.ts` (`MutateOpts.type: string | null`; record types on events)
- Modify: `src/replay.ts` (`typeAt` + type-aware `revert`)
- Test: `test/m10-type-aware-revert.test.ts`

- [ ] **Step 1: Write the failing test `test/m10-type-aware-revert.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { Replay } from "../src/replay";
import { TypeRegistry } from "../src/type-registry";
import { makeRegistryValidator } from "../src/registry-validator";
import { zodValidate } from "../src/zod-adapter";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";
import { z } from "zod";

function setup() {
  const registry = new TypeRegistry();
  registry.register("Page", {
    decompose: "opaque",
    validate: zodValidate(z.object({ title: z.string() }), "Page"),
  });
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson({ pages: { draft: null } }, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock, validate: makeRegistryValidator(registry) });
  return { tree, addressing, log, mutator };
}

describe("M10: type-aware revert", () => {
  it("set with { type: null } clears the node's type and skips validation", () => {
    const { addressing, mutator } = setup();
    mutator.set({ path: "/pages/draft" }, { title: "ok" }, { type: "Page" });
    expect(addressing.byPath("/pages/draft")!.type).toBe("Page");
    mutator.set({ path: "/pages/draft" }, "free text now", { type: null }); // would fail Page validation
    expect(addressing.byPath("/pages/draft")!.type).toBeUndefined();
  });

  it("reverting a typed node to its pre-type null state works WITHOUT any external workaround", () => {
    const { tree, addressing, log, mutator } = setup();
    const v0 = log.length(); // /pages/draft is null and untyped here
    mutator.set({ path: "/pages/draft" }, { title: "Hello" }, { type: "Page" });

    const replay = new Replay(tree, log);
    replay.revert(mutator, addressing, { path: "/pages/draft" }, v0); // used to throw ValidationError

    const node = addressing.byPath("/pages/draft")!;
    expect(tree.toJson(node.id)).toBeNull();
    expect(node.type).toBeUndefined(); // type restored to "untyped", not just value
  });

  it("a value→value revert keeps the type and still validates", () => {
    const { tree, addressing, log, mutator } = setup();
    mutator.set({ path: "/pages/draft" }, { title: "v1" }, { type: "Page" });
    const v1 = log.length();
    mutator.set({ path: "/pages/draft" }, { title: "v2" });

    new Replay(tree, log).revert(mutator, addressing, { path: "/pages/draft" }, v1);
    const node = addressing.byPath("/pages/draft")!;
    expect(tree.toJson(node.id)).toEqual({ title: "v1" });
    expect(node.type).toBe("Page");
  });

  it("set events record nodeTypeBefore/nodeType (null = untyped)", () => {
    const { log, mutator } = setup();
    mutator.set({ path: "/pages/draft" }, { title: "x" }, { type: "Page" });
    const e = log.entries()[0];
    expect(e.nodeTypeBefore).toBeNull(); // was untyped
    expect(e.nodeType).toBe("Page");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/m10-type-aware-revert.test.ts`
Expected: FAIL — `{type: null}` is a type error / revert throws `ValidationError` (Page schema rejects null); events lack the fields.

- [ ] **Step 3: Modify `src/event-log.ts`.** Add to `MutationEvent` (after `toPath?`):

```ts
  /** set/remove: the node's type BEFORE the op; insert/set: `nodeType` = type AFTER.
   *  `null` = explicitly untyped; ABSENT = pre-M10 event (unknown — replay keeps the current type). */
  nodeTypeBefore?: string | null;
  nodeType?: string | null;
```

- [ ] **Step 4: Modify `src/artifact-tree.ts`.** Change `replaceValue`'s signature and the type line (currently line 99 + 108):

```ts
  /** Replace the subtree value at `id` in place, keeping the node's id/key/parentId.
   *  `clearType` explicitly un-types the node (used by type-aware revert). */
  replaceValue(id: NodeId, value: Json, type?: string, clearType = false): void {
```

and replace `if (type !== undefined) node.type = type;` with:

```ts
    if (clearType) node.type = undefined;
    else if (type !== undefined) node.type = type;
```

- [ ] **Step 5: Modify `src/mutator.ts`.** In `MutateOpts`, widen the `type` field:

```ts
  /** Register/override the node's type (drives validation and the decompose override).
   *  `null` explicitly CLEARS the type (validation is skipped) — used by type-aware revert. */
  type?: string | null;
```

In `set`, replace the type computation + replaceValue + log.append with:

```ts
    const clearType = opts.type === null;
    const type = clearType ? undefined : (opts.type ?? node.type);
    this.deps.validate?.({ node, proposed: value, type, op: "set" });
    const before = this.tree.toJson(node.id);
    const typeBefore = node.type;
    const orphaned = this.tree.descendantIds(node.id);
    this.tree.replaceValue(node.id, value, type, clearType);
```

and in `set`'s `this.log.append({...})` add two fields (after `after: value,`):

```ts
      nodeTypeBefore: typeBefore ?? null,
      nodeType: type ?? null,
```

In `insert`: `const type = opts.type ?? undefined;` becomes (insert creates a new node, `null` and `undefined` both mean untyped):

```ts
    const type = opts.type ?? undefined;
```

Wait — `opts.type` is now `string | null | undefined`; normalize: `const type = opts.type === null ? undefined : opts.type;` and in insert's `log.append` add (after `after: value,`):

```ts
      nodeType: child.type ?? null,
```

In `remove`'s `log.append` add (after `before,`):

```ts
      nodeTypeBefore: node.type ?? null,
```

(`insertChild` already takes `type?: string` — passing the normalized `type` is unchanged. `move` records nothing: type travels with the node.)

- [ ] **Step 6: Modify `src/replay.ts`.** Add a private method to `Replay` and make `revert` type-aware:

```ts
  /** The node's type as of `version`: a string (typed), null (untyped/absent), or
   *  undefined (unknown/unchanged since `version` — leave the current type alone). */
  private typeAt(path: string, version: number): string | null | undefined {
    const events = this.log.entries();
    for (let seq = version; seq < events.length; seq++) {
      const e = events[seq];
      if (e.path !== path) continue;
      if (e.kind === "set" || e.kind === "remove") {
        // the first later op on this path saw the type the node had at `version`
        return e.nodeTypeBefore === undefined ? undefined : e.nodeTypeBefore;
      }
      if (e.kind === "insert") return null; // node did not exist at `version`
    }
    return undefined; // no later op touched it: type unchanged since `version`
  }

  /** Restore the node at `ref` to its value AND type as of `toVersion`, as a new live mutation. */
  revert(mutator: Mutator, addressing: Addressing, ref: Ref, toVersion: number): void {
    const path = "id" in ref ? addressing.pathOf(ref.id) : ref.path;
    const past = this.getAt(path, toVersion);
    const pastType = this.typeAt(path, toVersion);
    mutator.set({ path }, past ?? null, pastType === undefined ? {} : { type: pastType });
  }
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run test/m10-type-aware-revert.test.ts`
Expected: PASS (4 tests). Then `npx vitest run` — no regressions (M7 replay tests use untyped nodes; pre-existing event assertions use `toMatchObject`, ignoring the new optional fields).

- [ ] **Step 8: Typecheck + commit**

Run: `npm run typecheck` (clean), then:

```bash
git add src/event-log.ts src/artifact-tree.ts src/mutator.ts src/replay.ts test/m10-type-aware-revert.test.ts
git commit -m "feat: type-aware revert — events record node types; revert restores type-as-of-version (type:null clears)"
```

---

### Task 7: Honest docs + pin ifVersion semantics + capstone

**Files:**
- Modify: `README.md` (add a "Scope & limits" section)
- Test: `test/m10-hardening.test.ts` (capstone + ifVersion pin)

- [ ] **Step 1: Write the test `test/m10-hardening.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { SemanticIndex } from "../src/semantic-index";
import { MockEmbeddingPort } from "../src/embedding-port";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { serializeArtifact, restoreArtifact, MemoryStorage } from "../src/storage";
import { StaleVersionError } from "../src/errors";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function freshDeps(): TreeDeps {
  return { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
}

describe("M10 capstone: the index survives decomposition, restore, and failed transactions", () => {
  it("end-to-end", async () => {
    const tree = ArtifactTree.fromJson({ docs: {} }, freshDeps());
    const addressing = new Addressing(tree);
    const log = new EventLog();
    const vectors = new MemoryVectorIndex();
    const index = new SemanticIndex(tree, addressing, new MockEmbeddingPort(), vectors);
    const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0), ...index.hooks() });

    // decomposed children are queued (C1)
    mutator.insert({ path: "/docs" }, "page", { title: "alpha beta", body: "gamma delta" });
    const staleAfterInsert = index.staleCount();
    expect(staleAfterInsert).toBeGreaterThanOrEqual(2);

    // a failed transaction adds nothing to the queue (C3)
    expect(() =>
      mutator.transaction(() => {
        mutator.insert({ path: "/docs" }, "doomed", "ghost text");
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(index.staleCount()).toBe(staleAfterInsert);

    // persist while stale → restore → still searchable after reindex (C2)
    const store = new MemoryStorage();
    await store.save(serializeArtifact(tree, log, vectors));
    const loaded = (await store.load())!;
    const freshVectors = new MemoryVectorIndex();
    const { tree: rtree } = restoreArtifact(loaded, freshDeps(), freshVectors);
    const rindex = new SemanticIndex(rtree, new Addressing(rtree), new MockEmbeddingPort(), freshVectors);
    expect(rindex.staleCount()).toBe(staleAfterInsert);
    await rindex.reindex();
    const r = await rindex.search("alpha beta");
    expect(r.results.some((h) => h.path === "/docs/page/title")).toBe(true);
  });
});

describe("M10: ifVersion-on-insert semantics are parent-scoped (pinned + documented)", () => {
  it("two concurrent-style inserts with the same parent ifVersion: second is rejected", () => {
    const tree = ArtifactTree.fromJson({ docs: {} }, freshDeps());
    const addressing = new Addressing(tree);
    const mutator = new Mutator(tree, addressing, new EventLog(), { clock: new FixedClock(0) });
    const parentV = addressing.byPath("/docs")!.meta.version;
    mutator.insert({ path: "/docs" }, "a", "1", { ifVersion: parentV }); // CAS on the container: ok, bumps parent
    expect(() => mutator.insert({ path: "/docs" }, "b", "2", { ifVersion: parentV })).toThrow(StaleVersionError);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/m10-hardening.test.ts`
Expected: PASS — every piece was built in Tasks 1–6; the ifVersion test pins EXISTING behavior. (If the capstone fails, fix the owning task's source, not the test.)

- [ ] **Step 3: Add a "Scope & limits" section to `README.md`** (insert between "The stack" and "Quickstart"):

```markdown
## Scope & limits (read this before adopting)

- **Single process, single writer.** The tree lives in memory; storage is a snapshot
  target, not a database. There is no locking — two processes sharing one artifact
  file will clobber each other. One artifact = one run = one process.
- **Scoping is a guardrail, not a security boundary.** `writeScope`/`readScope`
  contain an agent's *tool calls* (including prompt-injected ones — a writer scoped
  to `/pages/home` has no path to `/secret`). They do NOT isolate *code*: every
  toolset shares the same heap, and anything holding the `Mutator` or tree can
  bypass scope. Do not run mutually-untrusted agent code in one process.
- **Growth is unbounded in v1.** The event log keeps full `before`/`after` values and
  is never compacted; `persist` serializes the whole artifact. Fine for pipeline
  runs (10²–10⁴ nodes, low-MB artifacts); wrong for long-lived, ever-growing state.
- **Vector search is brute-force cosine** — comfortable to ~10⁴ vectors; plug a real
  ANN store into `VectorIndexPort` beyond that.
- **Ops are id-anchored** (a useful property for a future CRDT backend), but there is
  **no CRDT**: no merge, no convergence, no multi-writer conflict resolution.
- **`ifVersion` on `insert` is parent-scoped:** it is a compare-and-set on the
  *container's* version, and every sibling insert bumps the container. Use it to
  guard "the container hasn't changed", not "my item is new".
```

- [ ] **Step 4: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all suites pass; no type errors.

- [ ] **Step 5: Commit**

```bash
git add README.md test/m10-hardening.test.ts
git commit -m "docs+test: M10 capstone, pin parent-scoped ifVersion-on-insert, honest Scope & limits in README"
```

---

## Milestone 10 — Definition of Done

- [ ] `npm test` — all suites pass (219 prior + ~15 new).
- [ ] `npm run typecheck` — no errors.
- [ ] The semantic index: indexes decomposed children (C1), survives persist→restore while stale (C2), and is restored by transaction rollback (C3).
- [ ] `Toolset.get` hands out no live references (I1).
- [ ] `FileStorage` saves atomically and rejects corrupt/invalid files with clear errors.
- [ ] `Replay.revert` restores value AND type as of the target version; `{type: null}` is a first-class clear. (The downstream `ArborRun.revertArtifact` node.type workaround becomes redundant — removing it there is a separate downstream change.)
- [ ] README documents the honest scope (single-process, cooperative scoping, growth limits, no CRDT, parent-scoped insert ifVersion).

## Roadmap: subsequent milestones (from the same review, by value/effort)

- **M11 — Packaging:** barrel `src/index.ts`, build (tsup → `dist/` + `.d.ts`), `exports`/`types`/`files`, un-`private` — makes Arbor installable instead of tsconfig-path-aliased.
- **M12 — Growth:** log compaction/checkpointing + delta persistence (write only events since last save).
- **Later:** tag/type indexes for `find` (O(matches) not O(nodes)); `stats()` + `subscribe`; ANN `VectorIndexPort` adapter when a consumer needs >10⁴ vectors.

---

## Self-Review (against the review findings)

**Coverage:** C1 → Task 2; C2 → Task 1; C3 → Task 3; I1 → Task 4; atomic/validated FileStorage → Task 5; type-aware revert (review rec #6 + downstream workaround) → Task 6; I2 pin+docs + "CRDT-ready"/scope honesty → Task 7. Out-of-scope items (packaging, compaction, find indexes, stats/subscribe, ANN) are explicitly deferred in the Roadmap.

**Placeholder scan:** none — every code step carries the full code; every run step has the command + expected outcome.

**Type consistency:** `MutatorDeps.onTxSnapshot/onTxRestore` (Task 3) match `SemanticIndex.hooks()`'s extended return type (Task 3). `MutateOpts.type: string | null` (Task 6) is consumed by `set` (normalize null→clearType) and `insert` (normalize null→undefined); `replaceValue(id, value, type?, clearType=false)` (Task 6) matches `set`'s call. `MutationEvent.nodeTypeBefore/nodeType: string | null | undefined-absent` (Task 6) are written by `set`/`insert`/`remove` and read by `Replay.typeAt` with the exact three-valued contract (string/null/undefined) that `revert` maps to `{type: pastType}` / `{}`. Tests import only existing modules + `StaleVersionError` from `arbor/errors` (exists since M2). Fixture threshold `sizeBasedDecision(1)` used everywhere inserts target empty scaffolds (the documented gotcha); Task 2's decomposition test relies on threshold 1 making `{title, body}` split with string-leaf children — correct (object >1 byte splits; strings are scalar leaves).
