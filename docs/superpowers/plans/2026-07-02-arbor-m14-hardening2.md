# Arbor — M14: Hardening-2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 8 probe-confirmed bugs + 1 data-integrity gap found by the post-M13 full review — all reachable from ordinary agent traffic: `move` corruption (parent-cycle hang, duplicate keys), inbound/outbound value aliasing that falsifies history, `reindex` interleaving (crash + silent stale vectors), log-floor violation in transactions, scoped-`find` false negatives, type-loss on revert across moves, and tags missing from the event log.

**Architecture:** No design changes — every fix is a local invariant guard, a defensive copy, or a re-validation after an await, in the module that owns the invariant. `move` gets the same pre-mutation validation discipline `insertChild` already has (validate everything BEFORE detaching). `reindex` re-validates each item against the live tree after the embed await. `MutationEvent` gains `tagsBefore`/`tags` (absent = pre-M14 event → behavior unchanged), and `Replay.typeAt` generalizes to a move-following `stateAt` that resolves type+tags, reading the LIVE followed node when the scan exhausts.

**Tech Stack:** Node ≥20.6, TypeScript (ESM, strict), Vitest. No new dependencies. Builds on M1–M13 (279 tests).

---

## Scope of THIS plan (Milestone 14)

The P0 list from the 2026-07-02 five-agent review — bugs reachable from normal agent traffic. Review finding ↔ task map:

| Review finding | Task |
|---|---|
| move into own subtree → parent cycle → `pathOf` hangs | 1 |
| move onto existing object key → duplicate keys, silent data loss | 1 |
| (bonus found while planning: object-move key-type check runs AFTER detach → orphan on throw) | 1 |
| inbound aliasing: `set`/`insert` store caller's live object in tree + event `after` | 2 |
| outbound aliasing: replay splices `before` by reference; toolset `history` returns live events | 2 |
| `reindex`: node removed during embed await → TypeError | 3 |
| `reindex`: node changed during embed await → marked fresh with stale vector (lost update) | 3 |
| `compactTo` inside a transaction → rollback silently corrupts versioning | 4 |
| scoped `find` applies `limit` before the scope filter → false negatives | 5 |
| `tags` not recorded in events → lost on revert/delta-restore | 6 |
| type-aware revert loses type across move-vacated paths | 7 |

**Out of scope (P1/P2, later):** `createArbor()` facade, async `VectorIndexPort`, `patch` return enrichment, typed-embedText-ancestor staleness propagation on shard writes (move fires no `onChange` at all — separate design pass), perf cheap wins (replay clone-once, byPath child map, glob), publish hygiene. Known limitation accepted and documented in-code: `stateAt`'s path following is exact for object paths; array-index paths can mis-resolve across sibling index shifts — same as pre-M14 `typeAt`.

## File structure (Milestone 14)

- Modify: `src/artifact-tree.ts` — `moveNode` pre-mutation guards (Task 1).
- Modify: `src/mutator.ts` — inbound `structuredClone` in `set`/`insert` (Task 2); tags in events (Task 6).
- Modify: `src/replay.ts` — clone `before` on reverse-apply (Task 2); `typeAt` → move-following `stateAt` (type+tags), revert applies both (Task 7).
- Modify: `src/toolset.ts` — `history` clones outbound (Task 2); `find` passes `within: readScope` (Task 5).
- Modify: `src/navigator.ts` — `FindOpts.within`, scope checked before the limit is consumed (Task 5).
- Modify: `src/semantic-index.ts` — interleave-safe `reindex` (Task 3).
- Modify: `src/event-log.ts` — `truncateTo` throws below the floor (Task 4); `tagsBefore`/`tags` event fields (Task 6).
- Modify: `src/delta.ts` — `applyEventForward` re-applies tags (Task 6).
- Test: `test/m14-move-guards.test.ts`, `test/m14-aliasing.test.ts`, `test/m14-reindex-interleave.test.ts`, `test/m14-log-floor.test.ts`, `test/m14-scoped-find.test.ts`, `test/m14-tags-events.test.ts`, `test/m14-revert-state.test.ts`, `test/m14-capstone.test.ts`.

### Shared test fixture (used, with per-task tweaks, in most new files)

```ts
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";
import type { Json } from "../src/types";

function setup(initial: Json) {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson(initial, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0) });
  return { tree, addressing, log, mutator };
}
```

(`sizeBasedDecision(1)` = fully decompose — small containers like `{}` are ≥2 bytes; the documented fixture gotcha.)

---

### Task 1: `moveNode` pre-mutation guards (cycle, duplicate key, orphan-on-throw)

**Files:**
- Modify: `src/artifact-tree.ts`
- Test: `test/m14-move-guards.test.ts`

- [ ] **Step 1: Write the failing test `test/m14-move-guards.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { makeToolset } from "../src/toolset";
import { InvalidOpError } from "../src/errors";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";
import type { Json } from "../src/types";

function setup(initial: Json) {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson(initial, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0) });
  return { tree, addressing, log, mutator };
}

describe("M14 moveNode guards", () => {
  it("rejects moving a node into its own subtree (would create a parent cycle)", () => {
    const s = setup({ a: { b: { c: "leaf!" } }, other: "xxxxxx" });
    const before = s.tree.toJson();
    expect(() => s.mutator.move({ path: "/a" }, { path: "/a/b" }, "loop")).toThrow(InvalidOpError);
    expect(s.tree.toJson()).toEqual(before); // nothing detached, nothing lost
    // parent chain still terminates (this hung forever pre-fix)
    expect(s.addressing.pathOf(s.addressing.byPath("/a/b/c")!.id)).toBe("/a/b/c");
    expect(s.log.length()).toBe(0); // nothing logged
  });

  it("rejects moving a node onto itself", () => {
    const s = setup({ a: { x: "1" }, b: {} });
    expect(() => s.mutator.move({ path: "/a" }, { path: "/a" }, "self")).toThrow(InvalidOpError);
  });

  it("rejects a move onto an existing object key (would silently shadow it)", () => {
    const s = setup({ src: { x: "hello!" }, dst: { k: "old-value", other: 22 } });
    const before = s.tree.toJson();
    expect(() => s.mutator.move({ path: "/src/x" }, { path: "/dst" }, "k")).toThrow(InvalidOpError);
    expect(s.tree.toJson()).toEqual(before);
    expect(s.tree.toJson(s.addressing.byPath("/dst/k")!.id)).toBe("old-value");
  });

  it("rejects a non-string key for an object move BEFORE detaching (no orphan)", () => {
    const s = setup({ src: { x: "hello!" }, dst: { other: 22 } });
    const before = s.tree.toJson();
    expect(() => s.mutator.move({ path: "/src/x" }, { path: "/dst" }, 0)).toThrow(InvalidOpError);
    expect(s.tree.toJson()).toEqual(before); // pre-fix: x was detached and lost
  });

  it("still allows a move onto the node's own current key (no-op reattach)", () => {
    const s = setup({ a: { x: "1" }, b: {} });
    s.mutator.move({ path: "/a/x" }, { path: "/a" }, "x");
    expect(s.tree.toJson()).toEqual({ a: { x: "1" }, b: {} });
  });

  it("legal cross-parent move still works and logs a move event", () => {
    const s = setup({ a: { x: "1" }, b: {} });
    s.mutator.move({ path: "/a/x" }, { path: "/b" }, "x");
    expect(s.tree.toJson()).toEqual({ a: {}, b: { x: "1" } });
    expect(s.log.entries().at(-1)!.kind).toBe("move");
  });

  it("surfaces as INVALID_OP through toolset patch (agent traffic)", async () => {
    const s = setup({ a: { b: {} } });
    const ts = makeToolset({ tree: s.tree, addressing: s.addressing, log: s.log, mutator: s.mutator });
    const r = await ts.patch({ path: "/a" }, { op: "move", to: { path: "/a/b" }, key: "loop" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_OP");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/m14-move-guards.test.ts --testTimeout=5000`
Expected: FAIL — the cycle test times out or hangs at `pathOf` (kill if needed and rely on the timeout), the duplicate-key and orphan tests fail on the corrupted-tree assertions. NOTE: the cycle test WILL hang without `--testTimeout`; the corrupted tree makes `mutator.move`'s internal `pathOf` loop forever. That's the bug.

- [ ] **Step 3: Replace `moveNode` in `src/artifact-tree.ts`** with a validate-everything-first version (keep the surrounding methods untouched):

```ts
  /** Move `id` under `newParentId` at `keyOrIndex`, preserving `id`. Renumbers affected arrays.
   *  ALL validation happens before any mutation — a rejected move leaves the tree untouched. */
  moveNode(id: NodeId, newParentId: NodeId, keyOrIndex: string | number): void {
    const node = this.nodes.get(id);
    if (!node) throw new InvalidOpError(`Unknown node: ${id}`);
    if (node.parentId === null) throw new InvalidOpError("cannot move the root");
    const newParent = this.nodes.get(newParentId);
    if (!newParent) throw new InvalidOpError(`Unknown node: ${newParentId}`);
    if (newParent.kind === "leaf") throw new InvalidOpError("cannot move into a leaf node");
    // Moving into itself or its own subtree would create a parent-chain cycle:
    // toJson silently drops the subtree and pathOf never terminates.
    let anc: NodeId | null = newParentId;
    while (anc !== null) {
      if (anc === id) throw new InvalidOpError("cannot move a node into itself or its own subtree");
      anc = this.nodes.get(anc)?.parentId ?? null;
    }
    if (newParent.kind === "object") {
      if (typeof keyOrIndex !== "string") throw new InvalidOpError("object move requires a string key");
      // Mirrors insertChild: a duplicate key silently shadows the existing child.
      if (newParent.childIds.some((cid) => cid !== id && this.nodes.get(cid)!.key === keyOrIndex)) {
        throw new InvalidOpError(`key already exists: ${keyOrIndex}`);
      }
    }

    const oldParent = this.nodes.get(node.parentId)!;
    const oldIdx = oldParent.childIds.indexOf(id);
    oldParent.childIds.splice(oldIdx, 1);
    if (oldParent.kind === "array") this.renumberArray(oldParent.id);

    if (newParent.kind === "object") {
      node.parentId = newParentId;
      node.key = keyOrIndex;
      newParent.childIds.push(id);
    } else {
      const at = typeof keyOrIndex === "number" ? Math.max(0, Math.min(keyOrIndex, newParent.childIds.length)) : newParent.childIds.length;
      node.parentId = newParentId;
      newParent.childIds.splice(at, 0, id);
      this.renumberArray(newParentId);
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/m14-move-guards.test.ts` → PASS (7 tests). Then `npx vitest run` — no regressions (existing move tests use legal moves).

- [ ] **Step 5: Typecheck + commit**

`npm run typecheck` clean, then:

```bash
git add src/artifact-tree.ts test/m14-move-guards.test.ts
git commit -m "fix: moveNode validates before mutating (self/subtree cycle, duplicate key, orphan-on-throw)"
```

---

### Task 2: Aliasing hygiene at the mutation, replay, and history boundaries

**Files:**
- Modify: `src/mutator.ts`, `src/replay.ts`, `src/toolset.ts`
- Test: `test/m14-aliasing.test.ts`

- [ ] **Step 1: Write the failing test `test/m14-aliasing.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { Replay } from "../src/replay";
import { makeToolset } from "../src/toolset";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";
import type { Json } from "../src/types";

function setup(initial: Json) {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson(initial, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0) });
  return { tree, addressing, log, mutator };
}

describe("M14 aliasing hygiene", () => {
  it("mutating the caller's object after set() changes neither the tree nor history", () => {
    const s = setup({ x: null });
    const v = { a: 1 };
    s.mutator.set({ path: "/x" }, v);
    v.a = 999; // caller keeps mutating their object
    expect(s.tree.toJson()).toEqual({ x: { a: 1 } });
    expect(s.log.entries()[0]!.after).toEqual({ a: 1 });
    expect(new Replay(s.tree, s.log).getAt("/x", 1)).toEqual({ a: 1 });
  });

  it("mutating the caller's object after insert() does not leak into the tree", () => {
    const s = setup({ docs: {} });
    const v = { body: "hi" };
    s.mutator.insert({ path: "/docs" }, "a", v);
    v.body = "VANDALIZED";
    expect(s.tree.toJson()).toEqual({ docs: { a: { body: "hi" } } });
    expect(s.log.entries()[0]!.after).toEqual({ body: "hi" });
  });

  it("mutating a reconstruction does not corrupt the log's before values", () => {
    const s = setup({ x: null });
    s.mutator.set({ path: "/x" }, { a: 1 }); // seq 0
    s.mutator.set({ path: "/x" }, { a: 2 }); // seq 1: before = {a:1}
    const replay = new Replay(s.tree, s.log);
    const v1 = replay.reconstructValueAt(1) as { x: { a: number } };
    v1.x.a = 777; // vandalize the reconstruction
    expect(replay.getAt("/x", 1)).toEqual({ a: 1 }); // history unharmed
  });

  it("toolset history returns clones — events cannot be corrupted by the caller", async () => {
    const s = setup({ x: null });
    s.mutator.set({ path: "/x" }, { a: 1 });
    const ts = makeToolset({ tree: s.tree, addressing: s.addressing, log: s.log, mutator: s.mutator });
    const r1 = await ts.history();
    expect(r1.ok).toBe(true);
    if (r1.ok) (r1.value[0]!.after as { a: number }).a = 666;
    const r2 = await ts.history();
    if (r2.ok) expect(r2.value[0]!.after).toEqual({ a: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/m14-aliasing.test.ts`
Expected: FAIL — all four (tree/log show `999`/`VANDALIZED`/`777`/`666`).

- [ ] **Step 3: Apply the three fixes.**

**(a) `src/mutator.ts` — `set`:** after the `checkVersion` call and before the `validate` call, add a defensive copy and use it everywhere `value` was used below (validate `proposed`, `replaceValue`, event `after`):

```ts
    // Defensive copy: neither the tree nor the event log may alias the caller's
    // live object — post-call mutation would silently rewrite state AND history.
    const cloned = structuredClone(value);
```

Then change, in `set`: `this.deps.validate?.({ node, proposed: cloned, type, op: "set" });`, `this.tree.replaceValue(node.id, cloned, type, clearType);`, and in the `log.append` object: `after: cloned,`.

**(b) `src/mutator.ts` — `insert`:** same pattern — add `const cloned = structuredClone(value);` after `checkVersion`, then `validate?.({ node: null, proposed: cloned, ... })`, `insertChild(parent.id, keyOrIndex, cloned, type)`, event `after: cloned,`.

**(c) `src/replay.ts` — `reverseApplyValue`:** clone the recorded value when splicing it into the working copy (the `set` and `remove` cases; `move` reuses a value already inside the working copy):

```ts
    case "set":
      return e.path === undefined ? value : setAtPath(value, e.path, structuredClone(e.before ?? null));
    case "insert":
      return e.path === undefined ? value : removeAtPath(value, e.path);
    case "remove":
      return e.path === undefined ? value : insertAtPath(value, e.path, structuredClone(e.before ?? null));
```

**(d) `src/toolset.ts` — `history`:** clone outbound. Replace the final `return` of the `history` body:

```ts
        return structuredClone(opts.limit !== undefined ? events.slice(-opts.limit) : events);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/m14-aliasing.test.ts` → PASS (4 tests). Then `npx vitest run` — no regressions. (Perf note, accepted: one extra `structuredClone` per mutation of the inbound value — negligible at leaf/section scale.)

- [ ] **Step 5: Typecheck + commit**

`npm run typecheck` clean, then:

```bash
git add src/mutator.ts src/replay.ts src/toolset.ts test/m14-aliasing.test.ts
git commit -m "fix: defensive copies at mutation/replay/history boundaries (aliased values falsified history)"
```

---

### Task 3: Interleave-safe `reindex`

**Files:**
- Modify: `src/semantic-index.ts`
- Test: `test/m14-reindex-interleave.test.ts`

- [ ] **Step 1: Write the failing test `test/m14-reindex-interleave.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { SemanticIndex } from "../src/semantic-index";
import { MemoryVectorIndex } from "../src/vector-index-port";
import type { EmbeddingPort } from "../src/embedding-port";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";
import type { Json } from "../src/types";

/** Embedder whose FIRST batch blocks until gate() is called — lets a test land
 *  mutations "during" the embed await. */
class GatedEmbedder implements EmbeddingPort {
  gate!: () => void;
  private readonly wait = new Promise<void>((res) => (this.gate = res));
  private calls = 0;
  async embed(texts: string[]): Promise<number[][]> {
    this.calls += 1;
    if (this.calls === 1) await this.wait;
    return texts.map((t) => [t.length, 1]);
  }
}

function setup(initial: Json, embedder: EmbeddingPort) {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson(initial, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const vectors = new MemoryVectorIndex();
  const index = new SemanticIndex(tree, addressing, embedder, vectors);
  const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0), ...index.hooks() });
  return { tree, addressing, log, mutator, index, vectors };
}

describe("M14 reindex interleaving", () => {
  it("a node changed during the embed await stays stale; the next pass embeds the new text", async () => {
    const embedder = new GatedEmbedder();
    const s = setup({ a: null }, embedder);
    s.mutator.set({ path: "/a" }, "v1-text"); // stale with the v1 hash
    const p = s.index.reindex(); // suspends inside embed (first batch is gated)
    s.mutator.set({ path: "/a" }, "v2-CHANGED-DURING-EMBED"); // re-marks stale, new hash
    embedder.gate();
    await p;
    const node = s.addressing.byPath("/a")!;
    expect(node.meta.embedding.state).toBe("stale"); // NOT falsely fresh (pre-fix: fresh with the v1 hash)
    expect(s.index.staleCount()).toBe(1); // still queued (pre-fix: 0, permanently lost)
    await s.index.reindex(); // second pass embeds v2
    expect(node.meta.embedding.state).toBe("fresh");
    expect(s.index.staleCount()).toBe(0);
  });

  it("a node removed during the embed await neither crashes reindex nor resurrects a vector", async () => {
    const embedder = new GatedEmbedder();
    const s = setup({ a: null, keep: null }, embedder);
    s.mutator.set({ path: "/a" }, "doomed-text");
    s.mutator.set({ path: "/keep" }, "kept-text");
    const keepId = s.addressing.byPath("/keep")!.id;
    const p = s.index.reindex();
    s.mutator.remove({ path: "/a" }); // vanishes mid-flight
    embedder.gate();
    await expect(p).resolves.toBeUndefined(); // pre-fix: TypeError reading 'meta'
    expect(s.vectors.has(keepId)).toBe(true); // survivor indexed
    await s.index.reindex(); // drain pendingRemoval
    expect(s.vectors.size()).toBe(1); // no resurrected vector for the removed node
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/m14-reindex-interleave.test.ts`
Expected: FAIL — test 1 sees `fresh`/`staleCount 0`; test 2 rejects with `TypeError: Cannot read properties of undefined (reading 'meta')`.

- [ ] **Step 3: Replace the `reindex()` method in `src/semantic-index.ts`** (only this method; keep everything else):

```ts
  /** Embed every stale node (one batch), upsert vectors, mark fresh, clear the processed ids.
   *  Interleave-safe: mutations landing during the embed await are respected — a node
   *  removed mid-flight is dropped (never resurrected), and a node whose text changed
   *  stays queued for the next pass instead of being marked fresh for the old text. */
  async reindex(): Promise<void> {
    // First: drain deferred removals (HOLE 2 fix — removals queued by sync hooks).
    for (const id of this.pendingRemoval) this.vectors.remove(id);
    this.pendingRemoval.clear();

    const ids = [...this.stale];
    if (ids.length === 0) return;
    const completed = new Set<NodeId>();
    const items: { id: NodeId; text: string; hash: string }[] = [];
    for (const id of ids) {
      const node = this.tree.get(id);
      if (!node) {
        completed.add(id);
        continue;
      }
      // HOLE 1 fix: guard-aware reindex — suppress shards that belong to a typed
      // ancestor's embedding unit.
      if (this.isSuppressedShard(node)) {
        node.meta.embedding = { state: "none" };
        this.vectors.remove(id);
        completed.add(id);
        continue;
      }
      const value = this.tree.toJson(id);
      const typeDef = node.type ? this.registry?.get(node.type) : undefined;
      const text = toEmbeddingText(node, value, typeDef);
      if (text === null) {
        node.meta.embedding = { state: "none" };
        this.vectors.remove(id);
        completed.add(id);
        continue;
      }
      items.push({ id, text, hash: textHash(text) });
    }
    if (items.length > 0) {
      const embedded = await this.embedding.embed(items.map((it) => it.text));
      // Mutations may have landed during the await — re-validate every item
      // against the live tree before trusting the embedded batch.
      const upserts: { nodeId: NodeId; vector: number[] }[] = [];
      for (const [i, it] of items.entries()) {
        const node = this.tree.get(it.id);
        if (!node) {
          this.vectors.remove(it.id); // removed mid-flight — do not resurrect
          completed.add(it.id);
          continue;
        }
        if (node.meta.embedding.state === "stale" && node.meta.embedding.textHash !== it.hash) {
          continue; // superseded mid-flight — leave queued for the next pass
        }
        upserts.push({ nodeId: it.id, vector: embedded[i] });
        node.meta.embedding = { state: "fresh", textHash: it.hash };
        completed.add(it.id);
      }
      if (upserts.length > 0) this.vectors.upsert(upserts);
    }
    for (const id of ids) {
      if (completed.has(id)) this.stale.delete(id);
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/m14-reindex-interleave.test.ts` → PASS (2 tests). Then `npx vitest run` — no regressions (uncontended reindex: every item completes, byte-identical behavior).

- [ ] **Step 5: Typecheck + commit**

`npm run typecheck` clean, then:

```bash
git add src/semantic-index.ts test/m14-reindex-interleave.test.ts
git commit -m "fix: reindex re-validates against the live tree after the embed await (crash + lost-update race)"
```

---

### Task 4: Log-floor discipline — `truncateTo` fails loudly below `baseSeq`

**Files:**
- Modify: `src/event-log.ts`
- Test: `test/m14-log-floor.test.ts`

- [ ] **Step 1: Write the failing test `test/m14-log-floor.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { InvalidOpError } from "../src/errors";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function setup() {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson({ docs: {} }, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0) });
  return { tree, addressing, log, mutator };
}

describe("M14 log floor discipline", () => {
  it("rollback after an in-transaction compactTo fails LOUDLY (versions cannot silently diverge)", () => {
    const s = setup();
    s.mutator.insert({ path: "/docs" }, "a", "1"); // seq 0
    s.mutator.set({ path: "/docs/a" }, "2"); // seq 1
    expect(() =>
      s.mutator.transaction(() => {
        s.mutator.set({ path: "/docs/a" }, "3"); // seq 2
        s.log.compactTo(3); // compaction INSIDE a tx — burns seqs 0-2
        throw new Error("boom"); // rollback wants truncateTo(2), below floor 3
      }),
    ).toThrow(InvalidOpError); // pre-fix: silent — log.length()=3 with a seq-2 tree
  });

  it("truncateTo at/above the floor still works (rollback across a compacted log)", () => {
    const log = new EventLog();
    const ev = { kind: "set" as const, targetId: "n1", parentId: "n0", key: "k", ts: 0 };
    for (let i = 0; i < 5; i++) log.append(ev);
    log.compactTo(2);
    log.truncateTo(3);
    expect(log.entries().map((e) => e.seq)).toEqual([2]);
    expect(log.length()).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/m14-log-floor.test.ts`
Expected: FAIL — test 1: no throw (rollback silently clamps).

- [ ] **Step 3: Modify `src/event-log.ts`.** Add the errors import at the top (the file currently imports only from `./types`):

```ts
import { InvalidOpError } from "./errors";
```

Replace `truncateTo`:

```ts
  /** Drop events past absolute `length` — used to roll back a failed transaction.
   *  Throws below the compaction floor: that history is gone and the log cannot roll
   *  back past it — `compactTo` must never run inside a transaction. */
  truncateTo(length: number): void {
    if (length < this.baseSeq) {
      throw new InvalidOpError(
        `cannot truncate to ${length}: events before ${this.baseSeq} were compacted away (compactTo must not run inside a transaction)`,
      );
    }
    this.events.length = length - this.baseSeq;
  }
```

Also extend the `compactTo` doc comment's first line with the constraint — append to the existing docstring: `Must NOT be called inside a Mutator transaction (rollback would need the dropped events).`

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/m14-log-floor.test.ts` → PASS (2 tests). Then `npx vitest run` — no regressions (all existing `truncateTo` calls are at/above the floor). Accepted tradeoff, note in the commit body: the rollback throw REPLACES the original in-tx error — the message names the misuse (`compactTo` in a tx), which is the actionable fact.

- [ ] **Step 5: Typecheck + commit**

`npm run typecheck` clean, then:

```bash
git add src/event-log.ts test/m14-log-floor.test.ts
git commit -m "fix: truncateTo throws below the compaction floor (in-tx compactTo corrupted versioning silently)"
```

---

### Task 5: Scoped `find` — scope filters BEFORE the limit is consumed

**Files:**
- Modify: `src/navigator.ts`, `src/toolset.ts`
- Test: `test/m14-scoped-find.test.ts`

- [ ] **Step 1: Write the failing test `test/m14-scoped-find.test.ts`**

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
  const tree = ArtifactTree.fromJson(
    { a: { x: "1", y: "2", z: "3" }, scoped: { hit1: "h1", hit2: "h2" } },
    deps,
  );
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0) });
  return { tree, addressing, log, mutator };
}

describe("M14 scoped find", () => {
  it("returns in-scope matches even when out-of-scope nodes would exhaust the limit", async () => {
    const s = setup();
    const ts = makeToolset(
      { tree: s.tree, addressing: s.addressing, log: s.log, mutator: s.mutator },
      { readScope: "/scoped" },
    );
    const r = await ts.find({ pathPattern: "/**" }, { limit: 3 });
    expect(r.ok).toBe(true);
    // pre-fix: [] — the limit was consumed by /a's out-of-scope hits, then filtered away
    if (r.ok) expect(r.value.map((h) => h.path).sort()).toEqual(["/scoped", "/scoped/hit1", "/scoped/hit2"]);
  });

  it("unscoped find is unchanged (within undefined)", async () => {
    const s = setup();
    const ts = makeToolset({ tree: s.tree, addressing: s.addressing, log: s.log, mutator: s.mutator });
    const r = await ts.find({ pathPattern: "/scoped/*" });
    if (r.ok) expect(r.value.map((h) => h.path).sort()).toEqual(["/scoped/hit1", "/scoped/hit2"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/m14-scoped-find.test.ts`
Expected: FAIL — first test gets `[]`.

- [ ] **Step 3: Modify `src/navigator.ts`.** Extend `FindOpts`:

```ts
export interface FindOpts {
  limit?: number;
  /** JSON Pointer prefix: only nodes at/under it are hits — checked BEFORE the
   *  limit is consumed, so out-of-scope matches never eat the budget. */
  within?: string;
}
```

Replace `find`:

```ts
  /** Find nodes matching ALL provided selector fields (exact `type`, `tag` membership, glob `pathPattern`). */
  find(selector: FindSelector, opts: FindOpts = {}): FindHit[] {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const within = opts.within;
    const hits: FindHit[] = [];
    const visit = (id: NodeId): void => {
      if (hits.length >= limit) return;
      const node = this.tree.get(id)!;
      if (this.matches(node, selector)) {
        const path = this.addressing.pathOf(node.id);
        if (within === undefined || path === within || path.startsWith(within + "/")) {
          hits.push({ id: node.id, path, type: node.type });
        }
      }
      for (const cid of node.childIds) {
        if (hits.length >= limit) break;
        visit(cid);
      }
    };
    visit(this.tree.rootIdValue());
    return hits;
  }
```

**Modify `src/toolset.ts`** — replace the `find` tool body (drop the post-filter):

```ts
    find: (selector, opts) =>
      run(() => navigator.find(selector, { ...opts, within: binding.readScope })),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/m14-scoped-find.test.ts` → PASS (2 tests). Then `npx vitest run` — no regressions (existing scoped-find tests asserted membership, which is preserved; unscoped behavior identical).

- [ ] **Step 5: Typecheck + commit**

`npm run typecheck` clean, then:

```bash
git add src/navigator.ts src/toolset.ts test/m14-scoped-find.test.ts
git commit -m "fix: scoped find checks scope before consuming the limit (false negatives at small limits)"
```

---

### Task 6: Record `tags` in the event log; delta-restore re-applies them

**Files:**
- Modify: `src/event-log.ts`, `src/mutator.ts`, `src/delta.ts`
- Test: `test/m14-tags-events.test.ts`

- [ ] **Step 1: Write the failing test `test/m14-tags-events.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { MemoryDeltaStorage } from "../src/delta-storage";
import { persistCheckpoint, persistDelta, restoreFromDelta } from "../src/delta";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function freshDeps(): TreeDeps {
  return { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
}
function setup() {
  const deps = freshDeps();
  const tree = ArtifactTree.fromJson({ docs: {} }, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0) });
  return { tree, addressing, log, mutator };
}

describe("M14 tags in the event log", () => {
  it("insert records the new tags; set records tagsBefore and tags", () => {
    const s = setup();
    s.mutator.insert({ path: "/docs" }, "a", "v1", { tags: ["draft"] });
    s.mutator.set({ path: "/docs/a" }, "v2", { tags: ["final"] });
    s.mutator.set({ path: "/docs/a" }, "v3"); // tags untouched
    expect(s.log.at(0)!.tags).toEqual(["draft"]);
    expect(s.log.at(1)!.tagsBefore).toEqual(["draft"]);
    expect(s.log.at(1)!.tags).toEqual(["final"]);
    expect(s.log.at(2)!.tagsBefore).toEqual(["final"]);
    expect(s.log.at(2)!.tags).toEqual(["final"]); // unchanged carries through
  });

  it("remove records tagsBefore", () => {
    const s = setup();
    s.mutator.insert({ path: "/docs" }, "a", "v1", { tags: ["draft"] });
    s.mutator.remove({ path: "/docs/a" });
    expect(s.log.at(1)!.tagsBefore).toEqual(["draft"]);
  });

  it("delta restore preserves tags on journal-touched nodes (find-by-tag survives)", async () => {
    const s = setup();
    const store = new MemoryDeltaStorage();
    const hw = await persistCheckpoint(store, s.tree, s.log, new MemoryVectorIndex());
    s.mutator.insert({ path: "/docs" }, "a", "v1", { tags: ["draft"] }); // journaled
    await persistDelta(store, s.log, hw);
    const r = (await restoreFromDelta(store, freshDeps(), new MemoryVectorIndex()))!;
    const raddr = new Addressing(r.tree);
    expect(raddr.byPath("/docs/a")!.tags).toEqual(["draft"]); // pre-fix: undefined
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/m14-tags-events.test.ts`
Expected: FAIL — event tag fields are `undefined`; restored node has no tags.

- [ ] **Step 3: Apply the three changes.**

**(a) `src/event-log.ts`** — add two optional fields to `MutationEvent`, after the `nodeType` field:

```ts
  /** set/remove: the node's tags BEFORE the op ([] = untagged).
   *  ABSENT = pre-M14 event (unknown — revert leaves the current tags alone). */
  tagsBefore?: string[];
  /** set/insert: the node's tags AFTER the op ([] = untagged). ABSENT = pre-M14. */
  tags?: string[];
```

**(b) `src/mutator.ts`** — record them:
- In `set`, next to `const typeBefore = node.type;` add `const tagsBefore = node.tags ?? [];` and in the `log.append` object add `tagsBefore,` and `tags: node.tags ?? [],` (the append runs after `opts.tags` was applied).
- In `insert`, add to the `log.append` object: `tags: child.tags ?? [],`.
- In `remove`, add to the `log.append` object: `tagsBefore: node.tags ?? [],`.

**(c) `src/delta.ts`** — `applyEventForward` re-applies tags. Replace the `set` and `insert` cases:

```ts
    case "set": {
      if (e.path === undefined) return;
      const opts: { type?: string | null; tags?: string[] } = {};
      if (e.nodeType !== undefined) opts.type = e.nodeType;
      if (e.tags !== undefined) opts.tags = e.tags;
      mutator.set({ path: e.path }, e.after ?? null, opts);
      return;
    }
    case "insert": {
      if (e.path === undefined || e.key === null) return;
      const opts: { type?: string | null; tags?: string[] } = {};
      if (e.nodeType !== undefined) opts.type = e.nodeType;
      if (e.tags !== undefined) opts.tags = e.tags;
      mutator.insert({ path: parentPointer(e.path) }, e.key, e.after ?? null, opts);
      return;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/m14-tags-events.test.ts` → PASS (3 tests). Then `npx vitest run` — no regressions (new optional fields; absent in old stored events → `applyEventForward` leaves tags alone, exactly the pre-M14 behavior).

- [ ] **Step 5: Typecheck + commit**

`npm run typecheck` clean, then:

```bash
git add src/event-log.ts src/mutator.ts src/delta.ts test/m14-tags-events.test.ts
git commit -m "feat: record tags in mutation events; delta-restore re-applies them (find-by-tag survived restore)"
```

---

### Task 7: Move-aware `stateAt` — revert restores type AND tags across move-vacated paths

**Files:**
- Modify: `src/replay.ts`
- Test: `test/m14-revert-state.test.ts`

- [ ] **Step 1: Write the failing test `test/m14-revert-state.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { Replay } from "../src/replay";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function setup() {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson({ a: null, b: {} }, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0) });
  return { tree, addressing, log, mutator };
}

describe("M14 revert restores type and tags across moves", () => {
  it("restores the type when the path was vacated by a move and re-occupied by an insert", () => {
    const s = setup();
    s.mutator.set({ path: "/a" }, "typed-value", { type: "T" }); // seq 0
    s.mutator.move({ path: "/a" }, { path: "/b" }, "moved"); // seq 1 — vacates /a
    s.mutator.insert({ path: "" }, "a", "new-untyped"); // seq 2 — re-occupies /a
    const replay = new Replay(s.tree, s.log);
    replay.revert(s.mutator, s.addressing, { path: "/a" }, 1); // back to post-seq-0 state
    const node = s.addressing.byPath("/a")!;
    expect(s.tree.toJson(node.id)).toBe("typed-value");
    expect(node.type).toBe("T"); // pre-fix: undefined (typeAt trusted the later insert)
  });

  it("restores tags as of the target version", () => {
    const s = setup();
    s.mutator.set({ path: "/a" }, "v1", { tags: ["x"] }); // seq 0
    s.mutator.set({ path: "/a" }, "v2", { tags: ["y"] }); // seq 1
    const replay = new Replay(s.tree, s.log);
    replay.revert(s.mutator, s.addressing, { path: "/a" }, 1); // state after seq 0
    expect(s.addressing.byPath("/a")!.tags).toEqual(["x"]);
  });

  it("pre-M14 events (no tags fields) leave the current tags untouched on revert", () => {
    const s = setup();
    s.mutator.set({ path: "/a" }, "v1"); // seq 0
    s.mutator.set({ path: "/a" }, "v2", { tags: ["keep-me"] }); // seq 1
    // Simulate a pre-M14 seq-1 event: strip the recorded tag fields.
    delete (s.log.at(1) as { tagsBefore?: string[] }).tagsBefore;
    const replay = new Replay(s.tree, s.log);
    replay.revert(s.mutator, s.addressing, { path: "/a" }, 1); // value → v1
    expect(s.tree.toJson(s.addressing.byPath("/a")!.id)).toBe("v1");
    expect(s.addressing.byPath("/a")!.tags).toEqual(["keep-me"]); // unknown history → keep
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/m14-revert-state.test.ts`
Expected: FAIL — test 1: `node.type` is `undefined`; test 2: tags stay `["y"]`.

- [ ] **Step 3: Modify `src/replay.ts`.** Replace the whole `typeAt` method with `stateAt`, and replace `revert`:

```ts
  /** The node's {type, tags} as of `version`, by scanning later events on its path.
   *  Move-aware: if the version-`version` occupant was moved away, follow it to its
   *  new path and keep scanning — its type/tags travel with it. If the scan exhausts
   *  on a FOLLOWED path, the occupant is the live node there — read it directly
   *  ("keep current" would read whatever now sits at the original path).
   *  type: string | null (untyped/absent) | undefined (unknown — keep current).
   *  tags: string[] ([] = untagged) | undefined (unknown/pre-M14 — keep current).
   *  Limitation (same as pre-M14): array-index paths can mis-resolve across sibling
   *  index shifts; exact for object paths. */
  private stateAt(
    path: string,
    version: number,
    addressing: Addressing,
  ): { type: string | null | undefined; tags: string[] | undefined } {
    const total = this.log.length();
    let p = path;
    for (let seq = Math.max(version, this.log.baseSeqValue()); seq < total; seq++) {
      const e = this.log.at(seq)!;
      if (e.kind === "move") {
        if (e.fromPath === p) {
          p = e.toPath ?? p; // occupant moved away — follow it
          continue;
        }
        if (e.toPath === p) return { type: null, tags: [] }; // something ELSE moved in → vacant at `version`
        continue;
      }
      if (e.path !== p) continue;
      if (e.kind === "set" || e.kind === "remove") {
        return {
          type: e.nodeTypeBefore === undefined ? undefined : e.nodeTypeBefore,
          tags: e.tagsBefore, // absent (pre-M14) → undefined = keep current
        };
      }
      if (e.kind === "insert") return { type: null, tags: [] }; // node did not exist at `version`
    }
    if (p !== path) {
      // Followed through moves and nothing later touched the occupant: it is the
      // live node at `p` — its type/tags are the version-`version` answer.
      const live = addressing.byPath(p);
      return { type: live?.type ?? null, tags: live?.tags ?? [] };
    }
    return { type: undefined, tags: undefined }; // untouched since `version` — keep current
  }

  /** Restore the node at `ref` to its value, type, AND tags as of `toVersion`, as a new live mutation. */
  revert(mutator: Mutator, addressing: Addressing, ref: Ref, toVersion: number): void {
    const path = "id" in ref ? addressing.pathOf(ref.id) : ref.path;
    const past = this.getAt(path, toVersion);
    const { type, tags } = this.stateAt(path, toVersion, addressing);
    const opts: { type?: string | null; tags?: string[] } = {};
    if (type !== undefined) opts.type = type;
    if (tags !== undefined) opts.tags = tags;
    mutator.set({ path }, past ?? null, opts);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/m14-revert-state.test.ts` → PASS (3 tests). Then `npx vitest run` — no regressions. Note: the M10 type-revert tests must stay green — `stateAt` returns identical type answers for move-free histories; reverts on untagged nodes now set `tags: []` (functionally identical to absent tags for `find`/`search`).

- [ ] **Step 5: Typecheck + commit**

`npm run typecheck` clean, then:

```bash
git add src/replay.ts test/m14-revert-state.test.ts
git commit -m "fix: revert resolves type+tags via move-following stateAt (type was lost across move-vacated paths)"
```

---

### Task 8: Capstone — hostile/buggy agent traffic cannot corrupt the artifact

**Files:**
- Test: `test/m14-capstone.test.ts`

- [ ] **Step 1: Write `test/m14-capstone.test.ts`** (should pass immediately — everything was built in Tasks 1–7; if it fails, fix the owning task's source, not the test):

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { Replay } from "../src/replay";
import { makeToolset } from "../src/toolset";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

describe("M14 capstone: adversarial agent traffic", () => {
  it("malicious/buggy patches get structured errors; state and history stay intact", async () => {
    const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
    const initial = { work: { draft: "text", meta: { k: "v" } }, other: { x: "1", y: "2", z: "3" } };
    const tree = ArtifactTree.fromJson(initial, deps);
    const addressing = new Addressing(tree);
    const log = new EventLog();
    const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0) });
    const agent = makeToolset(
      { tree, addressing, log, mutator },
      { owner: "agent-1", writeScope: "/work", readScope: "/work" },
    );

    // 1. cycle attack: move a container into its own subtree → INVALID_OP, no hang
    const r1 = await agent.patch({ path: "/work" }, { op: "move", to: { path: "/work/meta" }, key: "loop" });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.code).toBe("INVALID_OP");

    // 2. shadow attack: move onto an existing key → INVALID_OP, old value intact
    const r2 = await agent.patch(
      { path: "/work/draft" },
      { op: "move", to: { path: "/work/meta" }, key: "k" },
    );
    expect(r2.ok).toBe(false);
    expect(tree.toJson(addressing.byPath("/work/meta/k")!.id)).toBe("v");

    // 3. aliasing attack: keep mutating the payload after a successful patch
    const payload = { title: "clean" };
    const r3 = await agent.patch({ path: "/work/draft" }, { op: "set", value: payload });
    expect(r3.ok).toBe(true);
    payload.title = "INJECTED";
    expect(tree.toJson(addressing.byPath("/work/draft")!.id)).toEqual({ title: "clean" });

    // 4. scoped find under a tiny limit still sees in-scope nodes
    const r4 = await agent.find({ pathPattern: "/**" }, { limit: 2 });
    expect(r4.ok).toBe(true);
    if (r4.ok) {
      expect(r4.value.length).toBe(2);
      for (const h of r4.value) expect(h.path === "/work" || h.path.startsWith("/work/")).toBe(true);
    }

    // 5. history the agent reads cannot be used to corrupt the log
    const r5 = await agent.history({ path: "/work/draft" });
    expect(r5.ok).toBe(true);
    if (r5.ok && r5.value.length > 0) (r5.value[0]! as { after?: unknown }).after = "corrupted";

    // 6. after all attacks: time-travel to version 0 reproduces the initial artifact
    const replay = new Replay(tree, log);
    expect(replay.reconstructValueAt(0)).toEqual(initial);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/m14-capstone.test.ts` → PASS (1 test).

- [ ] **Step 3: Full suite + typecheck + build + commit**

Run: `npm test && npm run typecheck && npm run build` (all green), then:

```bash
git add test/m14-capstone.test.ts
git commit -m "test: M14 capstone — adversarial agent traffic leaves state and history intact"
```

---

## Milestone 14 — Definition of Done

- [ ] `npm test` all green (279 prior + ~24 new), `npm run typecheck` clean, `npm run build` (tsup) green.
- [ ] `moveNode` rejects self/subtree cycles and duplicate object keys BEFORE mutating; rejected moves leave the tree byte-identical; surfaced as `INVALID_OP` via toolset.
- [ ] Post-call mutation of a caller's value can no longer change the tree, the event log, or replay output; toolset `history` returns clones.
- [ ] `reindex` survives removes and supersedes during the embed await: no crash, no resurrected vectors, no falsely-fresh nodes; superseded ids stay queued.
- [ ] `truncateTo` below `baseSeq` throws `InvalidOpError`; `compactTo`'s docstring forbids in-transaction use.
- [ ] Scoped `find` returns in-scope matches regardless of out-of-scope match volume; unscoped behavior unchanged.
- [ ] `MutationEvent` carries `tagsBefore`/`tags` ([] = untagged, absent = pre-M14); delta-restore re-applies tags; revert restores type AND tags, including across move-vacated paths (live-node read on followed exhaustion).
- [ ] Capstone: the six-step adversarial sequence yields structured errors, intact state, and a correct version-0 reconstruction.

## Roadmap: next (P1 — pre-publish batch, separate plan)

`createArbor()` facade (construction + save/restore lifecycle + the restoreArtifact idGen guard), async `VectorIndexPort` (+ the pgvector/sqlite-vec adapters it unblocks), `patch` → `{ id, path, version }`, `find` truncation marker, shared `isWithin()` helper, `Ref` moved to types.ts, `ScopeViolationError` message fix, publish hygiene (LICENSE, CHANGELOG, CI, explicit exports map, README quickstart imports). P2: perf cheap wins (replay clone-once ≈100×, byPath child map ≈6×, glob find ≈30×, Float32Array vectors), typed-embedText-ancestor staleness propagation (+ `onChange` on move), AG-UI adapter.

## Self-Review

**Spec coverage:** all 8 probe-confirmed review bugs + the tags data-integrity gap map to Tasks 1–7 (table above); the capstone (Task 8) exercises the agent-reachable ones end-to-end through the toolset. The orphan-on-throw sub-bug found during planning is covered by Task 1's non-string-key test.

**Placeholder scan:** none — every code step carries complete code; every run step names the exact command and expected outcome; the one behavioral tradeoff (rollback throw replacing the original in-tx error) is stated with its rationale.

**Type consistency:** `moveNode` guards use only existing members (`nodes`, `childIds`, `key`, `parentId`, `InvalidOpError` already imported in artifact-tree.ts). `structuredClone` targets `Json` values (structured-cloneable by construction). `FindOpts.within?: string` consumed by toolset's `{ ...opts, within: binding.readScope }` (undefined readScope → undefined within → unchanged behavior). `MutationEvent.tagsBefore?/tags?: string[]` written by mutator (`node.tags ?? []`, `child.tags ?? []`), read by `applyEventForward` (`e.tags !== undefined`) and `stateAt` (`e.tagsBefore`); `MutateOpts.tags?: string[]` already exists and is applied in both `set` and `insert`. `stateAt(path, version, addressing)` — `Addressing` is already imported (type-only) in replay.ts and `revert` already receives an `Addressing` instance; return unions match `MutateOpts.type?: string | null` and `tags?: string[]` via the conditional opts build. `EventLog` gains an `InvalidOpError` import (currently types-only imports — verified). `SemanticIndex.reindex` uses only existing members (`stale`, `pendingRemoval`, `vectors`, `tree`, `registry`, `toEmbeddingText`, `textHash`) plus a local `Set<NodeId>` — `NodeId` already imported. Test fixtures use `sizeBasedDecision(1)` (documented gotcha) and `log.at(seq)` (M12 API). GatedEmbedder matches `EmbeddingPort.embed(texts: string[]): Promise<number[][]>` as consumed at semantic-index.ts:177/200.
