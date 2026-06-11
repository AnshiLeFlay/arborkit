# Arbor — M7: Replay / Time-Travel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconstruct the artifact's value at any past version, diff two versions, read a node's value at a version, and revert a node to a past value — all driven by the reversible event-log built in M2/M6.

**Architecture:** Time-travel is **value-level and path-addressed**. Each `MutationEvent` records the JSON-Pointer `path` it affected (and `fromPath`/`toPath` for moves), captured by the `Mutator` at mutation time. `reconstructValueAt(version)` starts from the current full JSON value and **reverse-applies** each event as a path-addressed JSON patch (set→restore `before`, insert→remove, remove→re-insert `before`, move→move back) in strict descending `seq` order. Path addressing (not node-id) is the key correctness choice: `set` re-decomposes subtrees so descendant node-ids are not stable across history, but JSON-Pointer paths are stable to re-decomposition, so value reconstruction stays correct over arbitrarily long histories. `getAt` reads a path out of the reconstructed value; `diff(vA,vB)` returns the operations (event slice) between two versions; `revert` reconstructs a past value and re-applies it as a new live `set` (history stays append-only).

**Tech Stack:** Node ≥20.6, TypeScript (ESM, strict), Vitest. No new dependencies (`structuredClone` is a Node global). Builds on M1–M6.

---

## Scope of THIS plan (Milestone 7)

Covers spec §8 replay / §10.7 — `getAt(ref/path, version)`, full-tree value reconstruction, `revert(ref, toVersion)`, `diff(vA, vB)`. Produces working, testable software: navigate the artifact's history by value, compare versions, and undo to a past state.

**Out of scope here (later milestones):** the scoped `makeToolset` + LangChain wrappers (M8) that would expose `getAt`/`history`/`revert` as agent tools, the scenario capstone (M9). Also deferred / explicitly NOT attempted: **id-stable** reconstruction (reconstruction is value/`toJson`-level — re-decomposed subtrees get fresh ids; that's fine for getAt/diff/revert which are value-semantic); structural value-level `diff` (M7's `diff` returns the operation list between versions, which is simpler and shows the actual mutations); snapshot-checkpoint acceleration (reverse-from-current is correct and fast enough at current scale — periodic-checkpoint replay is a future optimization).

## Design decisions (locked for M7)

1. **`version` = event-log position.** Version 0 = the initial `fromJson` state (before any mutation); version k = the state after applying the first k events (`seq` 0..k-1); version `log.length()` = current. `reconstructValueAt(v)` clamps `v` to `[0, log.length()]`.
2. **Value-level, path-addressed reconstruction.** Reverse-apply events as JSON-Pointer patches on the current full value. Path addressing is stable to `set`-driven re-decomposition (node-ids are not), so it is correct over long histories. Reconstruction yields the JSON **value**, not an id-stable tree.
3. **Events record their path.** The `Mutator` adds `path` (set/insert/remove) and `fromPath`/`toPath` (move) to each event — captured at the right moment (remove/move-source paths BEFORE the structural mutation; insert/move-dest paths AFTER). These are additive optional fields on `MutationEvent`; they serialize for free via M6 storage.
4. **`diff(vA, vB)` = the operations between versions** (a slice of the event-log), not a structural value diff. Simpler and shows exactly what changed.
5. **`revert` is a forward mutation.** It reads the past value and applies a live `mutator.set` — history is never rewritten; the revert itself is appended as a new `set` event.

## File Structure (Milestone 7)

- Create: `src/json-edit.ts` — pure JSON-Pointer value editing: `getAtPath`, `setAtPath`, `removeAtPath`, `insertAtPath`.
- Modify: `src/event-log.ts` — add optional `path?`/`fromPath?`/`toPath?` to `MutationEvent`.
- Modify: `src/mutator.ts` — `set`/`insert`/`remove`/`move` record the path(s) on their events.
- Create: `src/replay.ts` — `Replay` (`reconstructValueAt`, `getAt`, `diff`, `revert`) + the `reverseApplyValue` helper.
- Test: `test/json-edit.test.ts`, `test/mutator-paths.test.ts`, `test/replay.test.ts`, `test/m7-replay.test.ts`.

---

### Task 1: `json-edit.ts` — JSON-Pointer value editing

**Files:**
- Create: `src/json-edit.ts`
- Test: `test/json-edit.test.ts`

- [ ] **Step 1: Write the failing test `test/json-edit.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { getAtPath, setAtPath, removeAtPath, insertAtPath } from "../src/json-edit";

describe("getAtPath", () => {
  it("reads root and nested object/array paths", () => {
    expect(getAtPath({ a: { b: 1 } }, "")).toEqual({ a: { b: 1 } });
    expect(getAtPath({ a: { b: 1 } }, "/a/b")).toBe(1);
    expect(getAtPath({ a: [10, 20] }, "/a/1")).toBe(20);
  });
  it("returns undefined for a missing path", () => {
    expect(getAtPath({ a: 1 }, "/b")).toBeUndefined();
    expect(getAtPath({ a: [1] }, "/a/5")).toBeUndefined();
  });
});

describe("setAtPath", () => {
  it("replaces at a nested path without mutating the original", () => {
    const v = { a: { b: 1 } };
    const r = setAtPath(v, "/a/b", 2);
    expect(r).toEqual({ a: { b: 2 } });
    expect(v).toEqual({ a: { b: 1 } });
  });
  it("replaces the root when the pointer is empty", () => {
    expect(setAtPath({ a: 1 }, "", { z: 9 })).toEqual({ z: 9 });
  });
  it("replaces an array element by index", () => {
    expect(setAtPath({ a: [1, 2] }, "/a/1", 9)).toEqual({ a: [1, 9] });
  });
});

describe("removeAtPath", () => {
  it("deletes an object key", () => {
    expect(removeAtPath({ a: 1, b: 2 }, "/b")).toEqual({ a: 1 });
  });
  it("splices an array element out", () => {
    expect(removeAtPath({ a: [1, 2, 3] }, "/a/1")).toEqual({ a: [1, 3] });
  });
});

describe("insertAtPath", () => {
  it("sets a new object key", () => {
    expect(insertAtPath({ a: 1 }, "/b", 2)).toEqual({ a: 1, b: 2 });
  });
  it("splices into an array at an index, shifting the rest", () => {
    expect(insertAtPath({ a: [1, 3] }, "/a/1", 2)).toEqual({ a: [1, 2, 3] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/json-edit.test.ts`
Expected: FAIL — cannot resolve `../src/json-edit`.

- [ ] **Step 3: Write `src/json-edit.ts`**

```ts
import type { Json } from "./types";
import { parsePointer } from "./jsonpointer";

/** Read the value at a JSON Pointer, or undefined if any segment is missing. */
export function getAtPath(value: Json, pointer: string): Json | undefined {
  const segs = parsePointer(pointer);
  let cur: Json | undefined = value;
  for (const seg of segs) {
    if (Array.isArray(cur)) {
      const i = Number(seg);
      cur = Number.isInteger(i) && i >= 0 && i < cur.length ? cur[i] : undefined;
    } else if (cur !== null && typeof cur === "object") {
      cur = seg in cur ? (cur as Record<string, Json>)[seg] : undefined;
    } else {
      return undefined;
    }
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** Navigate (within `root`) to the container holding the pointer's last segment. */
function navParent(root: Json, pointer: string): { parent: Json; key: string } | undefined {
  const segs = parsePointer(pointer);
  if (segs.length === 0) return undefined;
  let cur: Json | undefined = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (Array.isArray(cur)) cur = cur[Number(seg)];
    else if (cur !== null && typeof cur === "object") cur = (cur as Record<string, Json>)[seg];
    else return undefined;
    if (cur === undefined || cur === null) return undefined;
  }
  return { parent: cur, key: segs[segs.length - 1] };
}

/** Return a copy of `value` with the value at `pointer` replaced (root → returns `newVal`). */
export function setAtPath(value: Json, pointer: string, newVal: Json): Json {
  if (pointer === "") return newVal;
  const clone = structuredClone(value);
  const pk = navParent(clone, pointer);
  if (!pk || pk.parent === null || typeof pk.parent !== "object") return clone;
  if (Array.isArray(pk.parent)) pk.parent[Number(pk.key)] = newVal;
  else (pk.parent as Record<string, Json>)[pk.key] = newVal;
  return clone;
}

/** Return a copy of `value` with the element at `pointer` removed (object delete / array splice). */
export function removeAtPath(value: Json, pointer: string): Json {
  if (pointer === "") return null;
  const clone = structuredClone(value);
  const pk = navParent(clone, pointer);
  if (!pk || pk.parent === null || typeof pk.parent !== "object") return clone;
  if (Array.isArray(pk.parent)) pk.parent.splice(Number(pk.key), 1);
  else delete (pk.parent as Record<string, Json>)[pk.key];
  return clone;
}

/** Return a copy of `value` with `val` inserted at `pointer` (object set / array splice-in). */
export function insertAtPath(value: Json, pointer: string, val: Json): Json {
  if (pointer === "") return val;
  const clone = structuredClone(value);
  const pk = navParent(clone, pointer);
  if (!pk || pk.parent === null || typeof pk.parent !== "object") return clone;
  if (Array.isArray(pk.parent)) pk.parent.splice(Number(pk.key), 0, val);
  else (pk.parent as Record<string, Json>)[pk.key] = val;
  return clone;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/json-edit.test.ts`
Expected: PASS (8 tests). Then `npx vitest run` — no regressions.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/json-edit.ts test/json-edit.test.ts
git commit -m "feat: JSON-Pointer value editing (get/set/remove/insertAtPath)"
```

---

### Task 2: Events record their path

**Files:**
- Modify: `src/event-log.ts` (add optional `path?`/`fromPath?`/`toPath?` to `MutationEvent`)
- Modify: `src/mutator.ts` (record paths in `set`/`insert`/`remove`/`move`)
- Test: `test/mutator-paths.test.ts`

- [ ] **Step 1: Write the failing test `test/mutator-paths.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function setup(json: unknown) {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson(json as never, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock });
  return { tree, addressing, log, mutator };
}

function last(log: EventLog) {
  const e = log.entries();
  return e[e.length - 1];
}

describe("Mutator records event paths", () => {
  it("set records the target's path", () => {
    const { mutator, log } = setup({ a: "x" });
    mutator.set({ path: "/a" }, "y");
    expect(last(log).path).toBe("/a");
  });

  it("insert records the new node's path", () => {
    const { mutator, log } = setup({ docs: {} });
    mutator.insert({ path: "/docs" }, "k", "v");
    expect(last(log).path).toBe("/docs/k");
  });

  it("remove records the removed node's pre-removal path", () => {
    const { mutator, log } = setup({ a: "x", b: "y" });
    mutator.remove({ path: "/b" });
    expect(last(log).path).toBe("/b");
  });

  it("move records fromPath and toPath", () => {
    const { mutator, log, addressing } = setup({ from: { x: "v" }, to: {} });
    const xId = addressing.byPath("/from/x")!.id;
    mutator.move({ id: xId }, { path: "/to" }, "x");
    expect(last(log).fromPath).toBe("/from/x");
    expect(last(log).toPath).toBe("/to/x");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mutator-paths.test.ts`
Expected: FAIL — events have no `path`/`fromPath`/`toPath`.

- [ ] **Step 3: Modify `src/event-log.ts`**

In the `MutationEvent` interface, add these optional fields (after `to?`):

```ts
  /** JSON Pointer of the affected node (set/insert: its path; remove: its pre-removal path). */
  path?: string;
  /** move: source path (before the move). */
  fromPath?: string;
  /** move: destination path (after the move). */
  toPath?: string;
```

- [ ] **Step 4: Modify `src/mutator.ts`**

Replace `set` (add `path` to the event):

```ts
  set(ref: Ref, value: Json, opts: MutateOpts = {}): void {
    const node = this.resolve(ref);
    this.checkScope(node, opts.writeScope);
    this.checkVersion(node, opts.ifVersion);
    const type = opts.type ?? node.type;
    this.deps.validate?.({ node, proposed: value, type, op: "set" });
    const before = this.tree.toJson(node.id);
    const orphaned = this.tree.descendantIds(node.id);
    this.tree.replaceValue(node.id, value, type);
    if (opts.tags !== undefined) node.tags = opts.tags;
    this.bump(node, opts.owner);
    this.deps.onChange?.(node);
    if (this.deps.onRemove) {
      for (const id of orphaned) this.deps.onRemove(id);
    }
    this.log.append({
      kind: "set",
      targetId: node.id,
      parentId: node.parentId,
      key: node.key,
      path: this.addressing.pathOf(node.id),
      before,
      after: value,
      actor: opts.owner,
      ts: this.deps.clock.now(),
    });
  }
```

Replace `insert` (add `path`):

```ts
  insert(parentRef: Ref, keyOrIndex: string | number, value: Json, opts: MutateOpts = {}): NodeId {
    const parent = this.resolve(parentRef);
    this.checkScope(parent, opts.writeScope);
    this.checkVersion(parent, opts.ifVersion);
    const type = opts.type;
    this.deps.validate?.({ node: null, proposed: value, type, op: "insert" });
    const newId = this.tree.insertChild(parent.id, keyOrIndex, value, type);
    const child = this.tree.get(newId)!;
    if (opts.tags !== undefined) child.tags = opts.tags;
    this.bump(parent, opts.owner);
    this.deps.onChange?.(child);
    this.log.append({
      kind: "insert",
      targetId: newId,
      parentId: parent.id,
      key: child.key,
      path: this.addressing.pathOf(newId),
      after: value,
      actor: opts.owner,
      ts: this.deps.clock.now(),
    });
    return newId;
  }
```

Replace `remove` (capture `path` BEFORE `removeChild`, add to event):

```ts
  remove(ref: Ref, opts: MutateOpts = {}): void {
    const node = this.resolve(ref);
    if (node.parentId === null) throw new InvalidOpError("cannot remove the root");
    this.checkScope(node, opts.writeScope);
    this.checkVersion(node, opts.ifVersion);
    const before = this.tree.toJson(node.id);
    const path = this.addressing.pathOf(node.id);
    const removedIds = [node.id, ...this.tree.descendantIds(node.id)];
    const parent = this.tree.get(node.parentId)!;
    const removedKey = node.key;
    this.tree.removeChild(node.parentId, node.id);
    this.bump(parent, opts.owner);
    if (this.deps.onRemove) {
      for (const id of removedIds) this.deps.onRemove(id);
    }
    this.log.append({
      kind: "remove",
      targetId: node.id,
      parentId: parent.id,
      key: removedKey,
      path,
      before,
      actor: opts.owner,
      ts: this.deps.clock.now(),
    });
  }
```

Replace `move` (capture `fromPath` before, `toPath` after, add both to event):

```ts
  move(ref: Ref, toParentRef: Ref, keyOrIndex: string | number, opts: MutateOpts = {}): void {
    const node = this.resolve(ref);
    if (node.parentId === null) throw new InvalidOpError("cannot move the root");
    const toParent = this.resolve(toParentRef);
    this.checkScope(node, opts.writeScope);
    this.checkScope(toParent, opts.writeScope);
    this.checkVersion(node, opts.ifVersion);
    const oldParentId = node.parentId;
    const from = { parentId: node.parentId, key: node.key };
    const fromPath = this.addressing.pathOf(node.id);
    this.tree.moveNode(node.id, toParent.id, keyOrIndex);
    const toPath = this.addressing.pathOf(node.id);
    const bumped = new Set<NodeId>();
    for (const id of [node.id, oldParentId, toParent.id]) {
      if (id !== null && !bumped.has(id)) {
        const n = this.tree.get(id);
        if (n) this.bump(n, opts.owner);
        bumped.add(id);
      }
    }
    this.log.append({
      kind: "move",
      targetId: node.id,
      parentId: toParent.id,
      key: node.key,
      from,
      to: { parentId: toParent.id, key: node.key },
      fromPath,
      toPath,
      actor: opts.owner,
      ts: this.deps.clock.now(),
    });
  }
```

(Do NOT modify `transaction`/guards/`bump`/`resolve`. Only the four mutation methods gain path fields on their appended events.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/mutator-paths.test.ts`
Expected: PASS (4 tests). Then `npx vitest run` — confirm NO regressions (existing event assertions use `toMatchObject`, which ignores the new optional fields).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/event-log.ts src/mutator.ts test/mutator-paths.test.ts
git commit -m "feat: Mutator records JSON-Pointer paths on events (for replay)"
```

---

### Task 3: `replay.ts` — `Replay` (reconstruct / getAt / diff / revert)

**Files:**
- Create: `src/replay.ts`
- Test: `test/replay.test.ts`

- [ ] **Step 1: Write the failing test `test/replay.test.ts`**

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

function setup(json: unknown) {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson(json as never, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock });
  return { tree, addressing, log, mutator };
}

describe("Replay.reconstructValueAt + getAt", () => {
  it("reconstructs the value at each version of a set chain, incl. the initial state", () => {
    const { tree, log, mutator } = setup({ docs: {} });
    mutator.insert({ path: "/docs" }, "a", "v1"); // version 1
    mutator.set({ path: "/docs/a" }, "v2"); // version 2
    mutator.set({ path: "/docs/a" }, "v3"); // version 3
    const replay = new Replay(tree, log);
    expect(replay.reconstructValueAt(0)).toEqual({ docs: {} });
    expect(replay.getAt("/docs/a", 1)).toBe("v1");
    expect(replay.getAt("/docs/a", 2)).toBe("v2");
    expect(replay.getAt("/docs/a", 3)).toBe("v3");
    expect(replay.getAt("/docs/a", 0)).toBeUndefined(); // not inserted yet
  });

  it("clamps version above current and at/below zero", () => {
    const { tree, log, mutator } = setup({ a: "x" });
    mutator.set({ path: "/a" }, "y"); // version 1 (current)
    const replay = new Replay(tree, log);
    expect(replay.getAt("/a", 99)).toBe("y"); // clamps to current
    expect(replay.getAt("/a", 0)).toBe("x"); // initial
  });
});

describe("Replay.diff", () => {
  it("returns the operations between two versions", () => {
    const { tree, log, mutator } = setup({ docs: {} });
    mutator.insert({ path: "/docs" }, "a", "x"); // seq 0
    mutator.set({ path: "/docs/a" }, "y"); // seq 1
    const replay = new Replay(tree, log);
    const d = replay.diff(1, 2);
    expect(d.length).toBe(1);
    expect(d[0].kind).toBe("set");
  });
});

describe("Replay.revert", () => {
  it("restores a node to a past value as a new appended mutation", () => {
    const { tree, addressing, log, mutator } = setup({ docs: {} });
    mutator.insert({ path: "/docs" }, "a", "original"); // version 1
    mutator.set({ path: "/docs/a" }, "changed"); // version 2
    const replay = new Replay(tree, log);
    replay.revert(mutator, addressing, { path: "/docs/a" }, 1);
    expect(tree.toJson()).toEqual({ docs: { a: "original" } });
    expect(log.length()).toBe(3); // revert appended a set
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/replay.test.ts`
Expected: FAIL — cannot resolve `../src/replay`.

- [ ] **Step 3: Write `src/replay.ts`**

```ts
import type { Json } from "./types";
import type { ArtifactTree } from "./artifact-tree";
import type { Addressing } from "./addressing";
import type { EventLog, MutationEvent } from "./event-log";
import type { Mutator } from "./mutator";
import type { Ref } from "./errors";
import { getAtPath, setAtPath, removeAtPath, insertAtPath } from "./json-edit";

/** Undo a single event on a JSON value, addressed by the event's recorded path(s). */
function reverseApplyValue(value: Json, e: MutationEvent): Json {
  switch (e.kind) {
    case "set":
      return e.path === undefined ? value : setAtPath(value, e.path, e.before ?? null);
    case "insert":
      return e.path === undefined ? value : removeAtPath(value, e.path);
    case "remove":
      return e.path === undefined ? value : insertAtPath(value, e.path, e.before ?? null);
    case "move": {
      if (e.toPath === undefined || e.fromPath === undefined) return value;
      const moved = getAtPath(value, e.toPath) ?? null;
      const withoutMoved = removeAtPath(value, e.toPath);
      return insertAtPath(withoutMoved, e.fromPath, moved);
    }
  }
}

/** Value-level time-travel over the reversible event-log. */
export class Replay {
  constructor(
    private readonly tree: ArtifactTree,
    private readonly log: EventLog,
  ) {}

  /** The whole artifact's JSON value as of `version` (0 = initial, log.length = current). */
  reconstructValueAt(version: number): Json {
    const total = this.log.length();
    const target = Math.max(0, Math.min(version, total));
    let value: Json = structuredClone(this.tree.toJson());
    const events = this.log.entries();
    for (let seq = total - 1; seq >= target; seq--) {
      value = reverseApplyValue(value, events[seq]);
    }
    return value;
  }

  /** The value at JSON Pointer `path` as of `version`, or undefined if absent then. */
  getAt(path: string, version: number): Json | undefined {
    return getAtPath(this.reconstructValueAt(version), path);
  }

  /** The mutations applied between version `vA` (inclusive) and `vB` (exclusive). */
  diff(vA: number, vB: number): MutationEvent[] {
    return [...this.log.entries()].slice(vA, vB);
  }

  /** Restore the node at `ref` to its value as of `toVersion`, as a new live mutation via `mutator`. */
  revert(mutator: Mutator, addressing: Addressing, ref: Ref, toVersion: number): void {
    const path = "id" in ref ? addressing.pathOf(ref.id) : ref.path;
    const past = this.getAt(path, toVersion);
    mutator.set({ path }, past ?? null);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/replay.test.ts`
Expected: PASS (4 tests). Then `npx vitest run` — no regressions.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/replay.ts test/replay.test.ts
git commit -m "feat: Replay value-level reconstruct/getAt/diff/revert (path-addressed)"
```

---

### Task 4: Capstone — reconstruct across insert/remove/move and revert

**Files:**
- Test: `test/m7-replay.test.ts` (test-only; exercises all op kinds through the history + revert)

- [ ] **Step 1: Write the failing test `test/m7-replay.test.ts`**

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

function setup(json: unknown) {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson(json as never, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock });
  return { tree, addressing, log, mutator };
}

describe("M7 replay integration", () => {
  it("reconstructs the value at each version across insert + remove", () => {
    const { tree, log, mutator } = setup({ docs: {} });
    mutator.insert({ path: "/docs" }, "a", "A"); // v1: {docs:{a:"A"}}
    mutator.insert({ path: "/docs" }, "b", "B"); // v2: {docs:{a:"A",b:"B"}}
    mutator.remove({ path: "/docs/a" }); // v3: {docs:{b:"B"}}
    const replay = new Replay(tree, log);
    expect(replay.reconstructValueAt(3)).toEqual({ docs: { b: "B" } });
    expect(replay.reconstructValueAt(2)).toEqual({ docs: { a: "A", b: "B" } });
    expect(replay.reconstructValueAt(1)).toEqual({ docs: { a: "A" } });
    expect(replay.reconstructValueAt(0)).toEqual({ docs: {} });
  });

  it("reconstructs the value across a move", () => {
    const { tree, log, mutator, addressing } = setup({ from: {}, to: {} });
    mutator.insert({ path: "/from" }, "x", "X"); // v1: {from:{x:"X"}, to:{}}
    const xId = addressing.byPath("/from/x")!.id;
    mutator.move({ id: xId }, { path: "/to" }, "x"); // v2: {from:{}, to:{x:"X"}}
    const replay = new Replay(tree, log);
    expect(replay.reconstructValueAt(2)).toEqual({ from: {}, to: { x: "X" } });
    expect(replay.reconstructValueAt(1)).toEqual({ from: { x: "X" }, to: {} });
  });

  it("reconstructs the value across an array insert + remove (index shifts handled)", () => {
    const { tree, log, mutator } = setup({ list: ["a", "c"] });
    mutator.insert({ path: "/list" }, 1, "b"); // v1: {list:["a","b","c"]}
    mutator.remove({ path: "/list/0" }); // v2: {list:["b","c"]}
    const replay = new Replay(tree, log);
    expect(replay.reconstructValueAt(2)).toEqual({ list: ["b", "c"] });
    expect(replay.reconstructValueAt(1)).toEqual({ list: ["a", "b", "c"] });
    expect(replay.reconstructValueAt(0)).toEqual({ list: ["a", "c"] });
  });

  it("revert undoes a container-level change back to a past value", () => {
    const { tree, addressing, log, mutator } = setup({ page: {} });
    mutator.set({ path: "/page" }, { title: "First", body: "one" }); // v1
    mutator.set({ path: "/page" }, { title: "Second", body: "two" }); // v2
    const replay = new Replay(tree, log);
    replay.revert(mutator, addressing, { path: "/page" }, 1);
    expect(tree.toJson()).toEqual({ page: { title: "First", body: "one" } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `npx vitest run test/m7-replay.test.ts`
Expected: PASS — every piece was built in Tasks 1–3. (If it fails, fix the corresponding source from the earlier task, not this test. The array-shift and move cases are the ones to watch — they validate that strict-descending-`seq` reverse-apply handles index shifts.)

- [ ] **Step 3: Run the full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all suites pass; no type errors.

- [ ] **Step 4: Commit**

```bash
git add test/m7-replay.test.ts
git commit -m "test: M7 replay end-to-end (reconstruct across insert/remove/move, revert)"
```

---

## Milestone 7 — Definition of Done

- [ ] `npm test` — all suites pass (M1–M7).
- [ ] `npm run typecheck` — no errors.
- [ ] You can: `reconstructValueAt(version)` to get the whole artifact's value at any point in history (0 = initial, current = now); `getAt(path, version)` to read one node's past value; `diff(vA, vB)` to list the operations between two versions; `revert(mutator, addressing, ref, toVersion)` to restore a node to a past value as a new appended mutation. Reconstruction is correct across `set`/`insert`/`remove`/`move` and array index shifts (path-addressed, robust to re-decomposition).

---

## Roadmap: subsequent plans

- **M8 — Toolset:** the scoped `makeToolset` exposes `describe`/`get`/`search`/`find`/`patch`/`history` (+ optionally `getAt`/`revert`) as LangChain tools; serialize `meta` at the boundary (closes the M4 known nit).
- **M9 — Scenario:** content-generator-shaped end-to-end fixtures, the runnable `examples/` script. (See the M1 plan roadmap.)

---

## Self-Review (against the spec)

**Spec coverage (this plan):** §8/§10.7 — `getAt(ref/path, version)` → Task 3 (`getAt`); full-tree value reconstruction → Task 3 (`reconstructValueAt`); `revert(ref, toVersion)` → Task 3 (`revert`, appends a live set); `diff(vA, vB)` → Task 3 (operation-list slice). The reversible event-log it consumes was built in M2; the path info it needs is added in Task 2; the JSON-Pointer editing primitives are Task 1; end-to-end across all op kinds → Task 4. Deferred items (id-stable reconstruction, structural value-diff, snapshot-checkpoint acceleration, toolset exposure) listed in Scope.

**Placeholder scan:** No TBD/TODO; every code step has full code; every run step has an exact command + expected result. Task 4 step 2 is a "should already pass" capstone with rationale (not a placeholder).

**Type consistency:** `getAtPath`/`setAtPath`/`removeAtPath`/`insertAtPath` (Task 1) are imported and used by `reverseApplyValue` in `replay.ts` (Task 3). `MutationEvent.path?`/`fromPath?`/`toPath?` (Task 2) are read by `reverseApplyValue` (Task 3) and written by the Mutator (Task 2) — field names consistent. `Replay` constructor `(tree, log)` and methods `reconstructValueAt(version)`, `getAt(path, version)`, `diff(vA, vB)`, `revert(mutator, addressing, ref, toVersion)` are defined in Task 3 and used in Tasks 3–4. `Ref` (`{id}|{path}`) reused from M2 `errors.ts`; `revert` resolves an id-ref via `addressing.pathOf` and a path-ref directly, then calls `mutator.set({path}, ...)` (existing M3+ signature). `Mutator`/`Addressing`/`ArtifactTree`/`EventLog`/`Json` imported as types where only typed (no import cycle: `replay.ts` imports `Mutator` as a type; `mutator.ts` does not import `replay.ts`).
