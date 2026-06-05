# Arbor — M2: Mutations & Reversible Event-Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add structural mutations (`set`/`insert`/`remove`/`move`) to the Arbor tree through a guarded `Mutator`, recording every change to an append-only reversible event-log, with optional write-scope, optimistic version checks, a pluggable validator hook, and atomic transactions.

**Architecture:** `ArtifactTree` (built in M1) gains low-level structural primitives (`replaceValue`/`insertChild`/`removeChild`/`moveNode` + `snapshot`/`restore`). A new `Mutator` is the guarded policy layer on top: it resolves a `Ref` (id or path) via `Addressing`, checks scope/version, runs an optional validator, calls the primitive, bumps the node's version, and appends a reversible `MutationEvent`. Errors are thrown as typed `ArborError` subclasses (the toolset in M8 will convert them to structured results). The semantic index (M5) and Zod validation (M3) are not built here — only their seams (embedding-state untouched; a no-op validator hook).

**Tech Stack:** Node ≥20.6, TypeScript (ESM, strict), Vitest. No new runtime dependencies. Builds on M1 (`src/types.ts`, `src/ids.ts`, `src/clock.ts`, `src/decompose.ts`, `src/artifact-tree.ts`, `src/addressing.ts`, `src/jsonpointer.ts`).

---

## Scope of THIS plan (Milestone 2)

Covers spec §8 (mutations, reversible event-log, versioning fields, scoping hook, typed errors, transactions; CRDT-readiness via id-anchored ops). Produces working, testable software: you can mutate the tree through validated, scoped, versioned, logged operations and roll them back atomically.

**Out of scope here (later milestones):** Zod schema validation (M3 — here only a no-op `Validator` hook), navigator read tools / exact tag index (M4), semantic index + embedding stale-marking (M5 — `set`/etc. do NOT touch `meta.embedding` yet), storage adapters (M6), the replay/`getAt`/`revert`/`diff` engine (M7 — M2 only RECORDS reversible events, it does not replay them), scoped toolset + LangChain wrappers (M8).

## Design decisions (locked for M2)

1. **Array indexing = stored numeric `key` (option "a").** M1 stores `key = index` for array children and `Addressing` relies on `key == position`. So `insert`/`remove`/`move` on arrays **renumber** affected siblings' `key` via `renumberArray`. M1 code is left untouched. (Renumber updates the positional `key` only — it does NOT bump sibling versions, since position is location-info, like a path, not content.)
2. **Mutator throws typed errors** (`ArborError` subclasses). The toolset (M8) catches and converts to `{ok:false, error}`. Within the core, throwing is simplest and testable.
3. **Structural primitives live on `ArtifactTree`** (it owns its nodes); `Mutator` is the thin guarded policy layer. Primitives reuse M1's private `build` to decompose new values.
4. **`transaction(fn)` = snapshot/restore.** Deep-clone the node map + rootId before `fn`; on throw, restore and truncate the log; rethrow. Simple and correct (deep-clone cost is acceptable at current scale; optimize later if needed).
5. **Validator is a hook**, default absent (no-op). M3 plugs in Zod. M2 only proves the hook blocks invalid mutations.
6. **Version bump rules:** `set` → target; `insert` → parent; `remove` → parent; `move` → moved node + old parent + new parent (deduped). New nodes start at version 0.

## File Structure (Milestone 2)

- Create: `src/errors.ts` — `Ref` type; `ArborError` + `NodeNotFoundError`, `ScopeViolationError`, `StaleVersionError`, `InvalidOpError`.
- Create: `src/event-log.ts` — `OpKind`, `MutationEvent`, `EventLog`.
- Modify: `src/artifact-tree.ts` — add `TreeSnapshot`; add primitives `replaceValue`, `insertChild`, `removeChild`, `moveNode`, `snapshot`, `restore` (+ private `deleteDescendants`, `renumberArray`). M1 methods unchanged.
- Create: `src/mutator.ts` — `MutateOpts`, `Validator`, `MutatorDeps`, `Mutator` (`set`/`insert`/`remove`/`move`/`transaction`).
- Test: `test/errors.test.ts`, `test/event-log.test.ts`, `test/artifact-tree-mutate.test.ts`, `test/mutator.test.ts`, `test/mutator-guards.test.ts`, `test/mutator-move-tx.test.ts`.

---

### Task 1: Typed errors + `Ref`

**Files:**
- Create: `src/errors.ts`
- Test: `test/errors.test.ts`

- [ ] **Step 1: Write the failing test `test/errors.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import {
  ArborError,
  NodeNotFoundError,
  ScopeViolationError,
  StaleVersionError,
  InvalidOpError,
} from "../src/errors";

describe("typed errors", () => {
  it("NodeNotFoundError carries code and ref and is an ArborError", () => {
    const e = new NodeNotFoundError({ path: "/pages/9" });
    expect(e).toBeInstanceOf(ArborError);
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("NODE_NOT_FOUND");
    expect(e.ref).toEqual({ path: "/pages/9" });
  });

  it("ScopeViolationError carries target path and allowed scope", () => {
    const e = new ScopeViolationError("/pages/1", "/pages/0");
    expect(e.code).toBe("SCOPE_VIOLATION");
    expect(e.targetPath).toBe("/pages/1");
    expect(e.writeScope).toBe("/pages/0");
  });

  it("StaleVersionError carries id, expected and actual", () => {
    const e = new StaleVersionError("n3", 1, 2);
    expect(e.code).toBe("STALE_VERSION");
    expect(e.id).toBe("n3");
    expect(e.expected).toBe(1);
    expect(e.actual).toBe(2);
  });

  it("InvalidOpError carries a code and message", () => {
    const e = new InvalidOpError("cannot remove root");
    expect(e.code).toBe("INVALID_OP");
    expect(e.message).toContain("cannot remove root");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/errors.test.ts`
Expected: FAIL — cannot resolve `../src/errors`.

- [ ] **Step 3: Write `src/errors.ts`**

```ts
import type { NodeId } from "./types";

/** A reference to a node: by stable id or by JSON Pointer path. */
export type Ref = { id: NodeId } | { path: string };

export class ArborError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NodeNotFoundError extends ArborError {
  constructor(public readonly ref: Ref) {
    super("NODE_NOT_FOUND", `Node not found: ${JSON.stringify(ref)}`);
  }
}

export class ScopeViolationError extends ArborError {
  constructor(
    public readonly targetPath: string,
    public readonly writeScope: string,
  ) {
    super("SCOPE_VIOLATION", `Write outside scope: ${targetPath} not within ${writeScope}`);
  }
}

export class StaleVersionError extends ArborError {
  constructor(
    public readonly id: NodeId,
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super("STALE_VERSION", `Stale version for ${id}: expected ${expected}, actual ${actual}`);
  }
}

export class InvalidOpError extends ArborError {
  constructor(message: string) {
    super("INVALID_OP", message);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/errors.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/errors.ts test/errors.test.ts
git commit -m "feat: typed Arbor errors and Ref type"
```

---

### Task 2: Event log

**Files:**
- Create: `src/event-log.ts`
- Test: `test/event-log.test.ts`

- [ ] **Step 1: Write the failing test `test/event-log.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { EventLog, type MutationEvent } from "../src/event-log";

function sampleEvent(): Omit<MutationEvent, "seq"> {
  return { kind: "set", targetId: "n1", parentId: "n0", key: "title", before: "Old", after: "New", ts: 0 };
}

describe("EventLog", () => {
  it("assigns monotonically increasing seq starting at 0", () => {
    const log = new EventLog();
    const a = log.append(sampleEvent());
    const b = log.append(sampleEvent());
    expect(a.seq).toBe(0);
    expect(b.seq).toBe(1);
    expect(log.length()).toBe(2);
  });

  it("preserves the appended payload alongside the seq", () => {
    const log = new EventLog();
    const e = log.append(sampleEvent());
    expect(e.kind).toBe("set");
    expect(e.before).toBe("Old");
    expect(e.after).toBe("New");
  });

  it("entries() returns all events in order", () => {
    const log = new EventLog();
    log.append(sampleEvent());
    log.append({ ...sampleEvent(), kind: "remove" });
    expect(log.entries().map((e) => e.kind)).toEqual(["set", "remove"]);
  });

  it("since(seq) returns events at or after a seq", () => {
    const log = new EventLog();
    log.append(sampleEvent());
    log.append(sampleEvent());
    log.append(sampleEvent());
    expect(log.since(1).map((e) => e.seq)).toEqual([1, 2]);
  });

  it("truncateTo(length) drops trailing events (transaction rollback support)", () => {
    const log = new EventLog();
    log.append(sampleEvent());
    log.append(sampleEvent());
    log.truncateTo(1);
    expect(log.length()).toBe(1);
    expect(log.entries().map((e) => e.seq)).toEqual([0]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/event-log.test.ts`
Expected: FAIL — cannot resolve `../src/event-log`.

- [ ] **Step 3: Write `src/event-log.ts`**

```ts
import type { Json, NodeId } from "./types";

export type OpKind = "set" | "insert" | "remove" | "move";

/**
 * A recorded mutation. Carries enough to reverse it later (M7 replay):
 * - set:    before = old subtree value, after = new value
 * - insert: after = inserted value (inverse is remove of targetId)
 * - remove: before = removed subtree value (inverse is insert at parentId/key)
 * - move:   from/to capture old and new (parentId, key)
 */
export interface MutationEvent {
  seq: number;
  kind: OpKind;
  targetId: NodeId;
  parentId: NodeId | null;
  key: string | number | null;
  before?: Json;
  after?: Json;
  from?: { parentId: NodeId | null; key: string | number | null };
  to?: { parentId: NodeId | null; key: string | number | null };
  actor?: string;
  ts: number;
}

/** Append-only log of mutations with monotonic seq. */
export class EventLog {
  private readonly events: MutationEvent[] = [];

  append(event: Omit<MutationEvent, "seq">): MutationEvent {
    const full: MutationEvent = { ...event, seq: this.events.length };
    this.events.push(full);
    return full;
  }

  entries(): readonly MutationEvent[] {
    return this.events;
  }

  since(seq: number): MutationEvent[] {
    return this.events.filter((e) => e.seq >= seq);
  }

  length(): number {
    return this.events.length;
  }

  /** Drop events past `length` — used to roll back a failed transaction. */
  truncateTo(length: number): void {
    this.events.length = length;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/event-log.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/event-log.ts test/event-log.test.ts
git commit -m "feat: append-only reversible event log"
```

---

### Task 3: `ArtifactTree` primitives — `replaceValue`, `snapshot`/`restore`

**Files:**
- Modify: `src/artifact-tree.ts` (add to the `ArtifactTree` class and add a `TreeSnapshot` export; do NOT change existing M1 methods)
- Test: `test/artifact-tree-mutate.test.ts`

- [ ] **Step 1: Write the failing test `test/artifact-tree-mutate.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";
import { sizeBasedDecision } from "../src/decompose";

function makeTree(json: unknown): ArtifactTree {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(5) };
  return ArtifactTree.fromJson(json as never, deps);
}

describe("ArtifactTree.replaceValue", () => {
  it("replaces a leaf value in place, keeping the same node id", () => {
    const tree = makeTree({ a: "x" });
    const aId = tree.children(tree.rootIdValue())[0].id;
    tree.replaceValue(aId, "y");
    expect(tree.get(aId)!.content).toBe("y");
    expect(tree.toJson()).toEqual({ a: "y" });
  });

  it("changes a leaf into a decomposed object, deleting no longer reachable descendants", () => {
    const tree = makeTree({ a: "x" });
    const aId = tree.children(tree.rootIdValue())[0].id;
    tree.replaceValue(aId, { deep: { nested: "val" } });
    expect(tree.get(aId)!.kind).toBe("object");
    expect(tree.toJson()).toEqual({ a: { deep: { nested: "val" } } });
  });

  it("drops orphaned descendants from the node map when replacing a subtree with a scalar", () => {
    const tree = makeTree({ a: { b: { c: 1 } } });
    const aId = tree.children(tree.rootIdValue())[0].id;
    const sizeBefore = tree.size();
    tree.replaceValue(aId, 0);
    expect(tree.get(aId)!.kind).toBe("leaf");
    expect(tree.get(aId)!.content).toBe(0);
    expect(tree.size()).toBeLessThan(sizeBefore);
    expect(tree.toJson()).toEqual({ a: 0 });
  });
});

describe("ArtifactTree.snapshot / restore", () => {
  it("restores the exact tree state after a snapshot", () => {
    const tree = makeTree({ a: { b: "x" } });
    const snap = tree.snapshot();
    const aId = tree.children(tree.rootIdValue())[0].id;
    tree.replaceValue(aId, "mutated");
    expect(tree.toJson()).toEqual({ a: "mutated" });
    tree.restore(snap);
    expect(tree.toJson()).toEqual({ a: { b: "x" } });
  });

  it("snapshot is independent (later mutations do not leak into it)", () => {
    const tree = makeTree({ n: 1 });
    const snap = tree.snapshot();
    const nId = tree.children(tree.rootIdValue())[0].id;
    tree.replaceValue(nId, 2);
    tree.restore(snap);
    expect(tree.toJson()).toEqual({ n: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/artifact-tree-mutate.test.ts`
Expected: FAIL — `tree.replaceValue is not a function` (and `snapshot`/`restore` undefined).

- [ ] **Step 3: Modify `src/artifact-tree.ts`**

First, add the `InvalidOpError` import and the `TreeSnapshot` export. At the top, change the import block to add:

```ts
import { InvalidOpError } from "./errors";
```

Add this exported interface just after the existing `TreeDeps` interface (before `export class ArtifactTree`):

```ts
export interface TreeSnapshot {
  nodes: Map<NodeId, ArbNode>;
  rootId: NodeId;
}
```

Then add the following methods INSIDE the `ArtifactTree` class, immediately before the final closing brace `}` of the class (after `toJson`). Do not modify any existing method:

```ts
  /** Replace the subtree value at `id` in place, keeping the node's id/key/parentId. */
  replaceValue(id: NodeId, value: Json): void {
    const node = this.nodes.get(id);
    if (!node) throw new InvalidOpError(`Unknown node: ${id}`);
    this.deleteDescendants(id);
    const opaque = this.deps.decision.isOpaque(value);
    const kind = kindOf(value, opaque);
    node.kind = kind;
    node.content = kind === "leaf" ? value : null;
    node.childIds = [];
    if (kind === "object") {
      for (const [k, v] of Object.entries(value as Record<string, Json>)) {
        node.childIds.push(this.build(v, id, k));
      }
    } else if (kind === "array") {
      (value as Json[]).forEach((v, i) => {
        node.childIds.push(this.build(v, id, i));
      });
    }
  }

  /** Recursively remove all descendants of `id` from the node map (keeps `id` itself). */
  private deleteDescendants(id: NodeId): void {
    const node = this.nodes.get(id);
    if (!node) return;
    for (const cid of node.childIds) {
      this.deleteDescendants(cid);
      this.nodes.delete(cid);
    }
    node.childIds = [];
  }

  /** Deep, independent copy of the tree state for transaction rollback. */
  snapshot(): TreeSnapshot {
    const nodes = new Map<NodeId, ArbNode>();
    for (const [id, node] of this.nodes) {
      nodes.set(id, structuredClone(node));
    }
    return { nodes, rootId: this.rootId };
  }

  /** Replace the tree state with a previously taken snapshot. */
  restore(snap: TreeSnapshot): void {
    this.nodes.clear();
    for (const [id, node] of snap.nodes) {
      this.nodes.set(id, structuredClone(node));
    }
    this.rootId = snap.rootId;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/artifact-tree-mutate.test.ts`
Expected: PASS (5 tests). Also run `npx vitest run` to confirm M1 tree tests still pass (no regressions).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/artifact-tree.ts test/artifact-tree-mutate.test.ts
git commit -m "feat: ArtifactTree replaceValue + snapshot/restore primitives"
```

---

### Task 4: `ArtifactTree` primitives — `insertChild`, `removeChild`, `moveNode`

**Files:**
- Modify: `src/artifact-tree.ts` (add methods to the class)
- Test: `test/artifact-tree-mutate.test.ts` (add a new `describe` block; do not modify existing tests)

- [ ] **Step 1: Add the failing tests to `test/artifact-tree-mutate.test.ts`**

Append these `describe` blocks at the end of the file (they reuse the `makeTree` helper already in the file):

```ts
describe("ArtifactTree.insertChild", () => {
  it("inserts a new keyed child into an object", () => {
    const tree = makeTree({ a: 1 });
    tree.insertChild(tree.rootIdValue(), "b", 2);
    expect(tree.toJson()).toEqual({ a: 1, b: 2 });
  });

  it("rejects inserting a duplicate object key", () => {
    const tree = makeTree({ a: 1 });
    expect(() => tree.insertChild(tree.rootIdValue(), "a", 9)).toThrow();
  });

  it("inserts into an array at an index and renumbers keys to match positions", () => {
    const tree = makeTree({ arr: ["x", "z"] });
    const arrId = tree.children(tree.rootIdValue())[0].id;
    tree.insertChild(arrId, 1, "y"); // insert at index 1
    expect(tree.toJson()).toEqual({ arr: ["x", "y", "z"] });
    expect(tree.children(arrId).map((c) => c.key)).toEqual([0, 1, 2]);
  });

  it("rejects inserting into a leaf", () => {
    const tree = makeTree({ a: 1 });
    const aId = tree.children(tree.rootIdValue())[0].id;
    expect(() => tree.insertChild(aId, "x", 1)).toThrow();
  });
});

describe("ArtifactTree.removeChild", () => {
  it("removes an object key", () => {
    const tree = makeTree({ a: 1, b: 2 });
    const bId = tree.children(tree.rootIdValue()).find((c) => c.key === "b")!.id;
    tree.removeChild(tree.rootIdValue(), bId);
    expect(tree.toJson()).toEqual({ a: 1 });
  });

  it("removes an array element and renumbers remaining keys", () => {
    const tree = makeTree({ arr: ["x", "y", "z"] });
    const arrId = tree.children(tree.rootIdValue())[0].id;
    const yId = tree.children(arrId)[1].id;
    tree.removeChild(arrId, yId);
    expect(tree.toJson()).toEqual({ arr: ["x", "z"] });
    expect(tree.children(arrId).map((c) => c.key)).toEqual([0, 1]);
  });
});

describe("ArtifactTree.moveNode", () => {
  it("re-parents a node, preserving its id, and renumbers affected arrays", () => {
    const tree = makeTree({ from: ["a", "b"], to: ["c"] });
    const fromId = tree.children(tree.rootIdValue()).find((c) => c.key === "from")!.id;
    const toId = tree.children(tree.rootIdValue()).find((c) => c.key === "to")!.id;
    const aId = tree.children(fromId)[0].id; // "a"
    tree.moveNode(aId, toId, 1); // append "a" at index 1 of `to`
    expect(tree.get(aId)!.id).toBe(aId); // identity preserved
    expect(tree.toJson()).toEqual({ from: ["b"], to: ["c", "a"] });
    expect(tree.children(fromId).map((c) => c.key)).toEqual([0]);
    expect(tree.children(toId).map((c) => c.key)).toEqual([0, 1]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/artifact-tree-mutate.test.ts`
Expected: FAIL — `tree.insertChild is not a function` (and `removeChild`/`moveNode`).

- [ ] **Step 3: Modify `src/artifact-tree.ts`**

Add the following methods INSIDE the `ArtifactTree` class, before the final closing brace (after the methods added in Task 3):

```ts
  /** Insert a decomposed `value` as a child of `parentId`. For objects `keyOrIndex` is the string key; for arrays it is the insert index. Returns the new child's id. */
  insertChild(parentId: NodeId, keyOrIndex: string | number, value: Json): NodeId {
    const parent = this.nodes.get(parentId);
    if (!parent) throw new InvalidOpError(`Unknown node: ${parentId}`);
    if (parent.kind === "object") {
      if (typeof keyOrIndex !== "string") {
        throw new InvalidOpError("object insert requires a string key");
      }
      if (parent.childIds.some((cid) => this.nodes.get(cid)!.key === keyOrIndex)) {
        throw new InvalidOpError(`key already exists: ${keyOrIndex}`);
      }
      const cid = this.build(value, parentId, keyOrIndex);
      parent.childIds.push(cid);
      return cid;
    }
    if (parent.kind === "array") {
      if (typeof keyOrIndex !== "number") {
        throw new InvalidOpError("array insert requires a numeric index");
      }
      const at = Math.max(0, Math.min(keyOrIndex, parent.childIds.length));
      const cid = this.build(value, parentId, at);
      parent.childIds.splice(at, 0, cid);
      this.renumberArray(parentId);
      return cid;
    }
    throw new InvalidOpError("cannot insert into a leaf node");
  }

  /** Remove `childId` (and its subtree) from `parentId`. Renumbers array siblings. */
  removeChild(parentId: NodeId, childId: NodeId): void {
    const parent = this.nodes.get(parentId);
    if (!parent) throw new InvalidOpError(`Unknown node: ${parentId}`);
    const idx = parent.childIds.indexOf(childId);
    if (idx < 0) throw new InvalidOpError(`${childId} is not a child of ${parentId}`);
    this.deleteDescendants(childId);
    this.nodes.delete(childId);
    parent.childIds.splice(idx, 1);
    if (parent.kind === "array") this.renumberArray(parentId);
  }

  /** Move `id` under `newParentId` at `keyOrIndex`, preserving `id`. Renumbers affected arrays. */
  moveNode(id: NodeId, newParentId: NodeId, keyOrIndex: string | number): void {
    const node = this.nodes.get(id);
    if (!node) throw new InvalidOpError(`Unknown node: ${id}`);
    if (node.parentId === null) throw new InvalidOpError("cannot move the root");
    const newParent = this.nodes.get(newParentId);
    if (!newParent) throw new InvalidOpError(`Unknown node: ${newParentId}`);
    if (newParent.kind === "leaf") throw new InvalidOpError("cannot move into a leaf node");

    const oldParent = this.nodes.get(node.parentId)!;
    const oldIdx = oldParent.childIds.indexOf(id);
    oldParent.childIds.splice(oldIdx, 1);
    if (oldParent.kind === "array") this.renumberArray(oldParent.id);

    if (newParent.kind === "object") {
      if (typeof keyOrIndex !== "string") throw new InvalidOpError("object move requires a string key");
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

  /** Set each array child's `key` to its current position. */
  private renumberArray(parentId: NodeId): void {
    const parent = this.nodes.get(parentId);
    if (!parent) return;
    parent.childIds.forEach((cid, i) => {
      this.nodes.get(cid)!.key = i;
    });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/artifact-tree-mutate.test.ts`
Expected: PASS (all blocks). Also run `npx vitest run` — no regressions.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/artifact-tree.ts test/artifact-tree-mutate.test.ts
git commit -m "feat: ArtifactTree insertChild/removeChild/moveNode primitives"
```

---

### Task 5: `Mutator` — `set` / `insert` / `remove` (resolve, version bump, event recording)

**Files:**
- Create: `src/mutator.ts`
- Test: `test/mutator.test.ts`

- [ ] **Step 1: Write the failing test `test/mutator.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { NodeNotFoundError } from "../src/errors";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";
import { sizeBasedDecision } from "../src/decompose";

function setup(json: unknown) {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(5) };
  const tree = ArtifactTree.fromJson(json as never, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock });
  return { tree, addressing, log, mutator, clock };
}

describe("Mutator.set", () => {
  it("replaces a value, bumps the node version, and logs before/after", () => {
    const { tree, addressing, log, mutator, clock } = setup({ title: "Old" });
    clock.advance(10);
    mutator.set({ path: "/title" }, "New");
    expect(tree.toJson()).toEqual({ title: "New" });
    const node = addressing.byPath("/title")!;
    expect(node.meta.version).toBe(1);
    expect(node.meta.updatedAt).toBe(10);
    const e = log.entries()[0];
    expect(e).toMatchObject({ kind: "set", before: "Old", after: "New", targetId: node.id });
  });

  it("resolves a Ref by id as well as by path", () => {
    const { tree, addressing, mutator } = setup({ title: "Old" });
    const id = addressing.byPath("/title")!.id;
    mutator.set({ id }, "ById");
    expect(tree.toJson()).toEqual({ title: "ById" });
  });

  it("throws NodeNotFoundError for a missing ref", () => {
    const { mutator } = setup({ title: "Old" });
    expect(() => mutator.set({ path: "/nope" }, 1)).toThrow(NodeNotFoundError);
  });
});

describe("Mutator.insert", () => {
  it("inserts an object key, bumps the PARENT version, and logs the insert", () => {
    const { tree, addressing, log, mutator } = setup({ a: 1 });
    const newId = mutator.insert({ path: "" }, "b", 2);
    expect(tree.toJson()).toEqual({ a: 1, b: 2 });
    expect(addressing.byPath("")!.meta.version).toBe(1); // root (parent) bumped
    expect(tree.get(newId)!.meta.version).toBe(0); // new node starts at 0
    expect(log.entries()[0]).toMatchObject({ kind: "insert", targetId: newId, after: 2 });
  });
});

describe("Mutator.remove", () => {
  it("removes a node, bumps the parent version, and logs before", () => {
    const { tree, addressing, log, mutator } = setup({ a: 1, b: 2 });
    mutator.remove({ path: "/b" });
    expect(tree.toJson()).toEqual({ a: 1 });
    expect(addressing.byPath("")!.meta.version).toBe(1);
    expect(log.entries()[0]).toMatchObject({ kind: "remove", before: 2 });
  });

  it("refuses to remove the root", () => {
    const { mutator } = setup({ a: 1 });
    expect(() => mutator.remove({ path: "" })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mutator.test.ts`
Expected: FAIL — cannot resolve `../src/mutator`.

- [ ] **Step 3: Write `src/mutator.ts`**

```ts
import type { ArbNode, Json, NodeId } from "./types";
import type { Clock } from "./clock";
import type { ArtifactTree } from "./artifact-tree";
import type { Addressing } from "./addressing";
import type { EventLog, OpKind } from "./event-log";
import { type Ref, NodeNotFoundError, ScopeViolationError, StaleVersionError, InvalidOpError } from "./errors";

/** Optional validation hook. Throws to reject a mutation. M3 plugs Zod in here. */
export type Validator = (input: { node: ArbNode | null; proposed: Json; type?: string; op: OpKind }) => void;

export interface MutatorDeps {
  clock: Clock;
  validate?: Validator;
}

export interface MutateOpts {
  owner?: string;
  /** JSON Pointer prefix; the target must be at or under it. */
  writeScope?: string;
  /** Optimistic concurrency: reject unless the target's current version equals this. */
  ifVersion?: number;
}

export class Mutator {
  constructor(
    private readonly tree: ArtifactTree,
    private readonly addressing: Addressing,
    private readonly log: EventLog,
    private readonly deps: MutatorDeps,
  ) {}

  private resolve(ref: Ref): ArbNode {
    const node = "id" in ref ? this.addressing.byId(ref.id) : this.addressing.byPath(ref.path);
    if (!node) throw new NodeNotFoundError(ref);
    return node;
  }

  private checkScope(node: ArbNode, writeScope?: string): void {
    if (writeScope === undefined) return;
    const path = this.addressing.pathOf(node.id);
    if (path !== writeScope && !path.startsWith(writeScope + "/")) {
      throw new ScopeViolationError(path, writeScope);
    }
  }

  private checkVersion(node: ArbNode, ifVersion?: number): void {
    if (ifVersion !== undefined && node.meta.version !== ifVersion) {
      throw new StaleVersionError(node.id, ifVersion, node.meta.version);
    }
  }

  private bump(node: ArbNode, owner?: string): void {
    node.meta.version += 1;
    node.meta.updatedAt = this.deps.clock.now();
    if (owner !== undefined) node.meta.owner = owner;
  }

  set(ref: Ref, value: Json, opts: MutateOpts = {}): void {
    const node = this.resolve(ref);
    this.checkScope(node, opts.writeScope);
    this.checkVersion(node, opts.ifVersion);
    this.deps.validate?.({ node, proposed: value, type: node.type, op: "set" });
    const before = this.tree.toJson(node.id);
    this.tree.replaceValue(node.id, value);
    this.bump(node, opts.owner);
    this.log.append({
      kind: "set",
      targetId: node.id,
      parentId: node.parentId,
      key: node.key,
      before,
      after: value,
      actor: opts.owner,
      ts: this.deps.clock.now(),
    });
  }

  insert(parentRef: Ref, keyOrIndex: string | number, value: Json, opts: MutateOpts = {}): NodeId {
    const parent = this.resolve(parentRef);
    this.checkScope(parent, opts.writeScope);
    this.checkVersion(parent, opts.ifVersion);
    this.deps.validate?.({ node: null, proposed: value, type: undefined, op: "insert" });
    const newId = this.tree.insertChild(parent.id, keyOrIndex, value);
    this.bump(parent, opts.owner);
    const child = this.tree.get(newId)!;
    this.log.append({
      kind: "insert",
      targetId: newId,
      parentId: parent.id,
      key: child.key,
      after: value,
      actor: opts.owner,
      ts: this.deps.clock.now(),
    });
    return newId;
  }

  remove(ref: Ref, opts: MutateOpts = {}): void {
    const node = this.resolve(ref);
    if (node.parentId === null) throw new InvalidOpError("cannot remove the root");
    this.checkScope(node, opts.writeScope);
    this.checkVersion(node, opts.ifVersion);
    const before = this.tree.toJson(node.id);
    const parent = this.tree.get(node.parentId)!;
    const removedKey = node.key;
    this.tree.removeChild(node.parentId, node.id);
    this.bump(parent, opts.owner);
    this.log.append({
      kind: "remove",
      targetId: node.id,
      parentId: parent.id,
      key: removedKey,
      before,
      actor: opts.owner,
      ts: this.deps.clock.now(),
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/mutator.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/mutator.ts test/mutator.test.ts
git commit -m "feat: Mutator set/insert/remove with version bump and event log"
```

---

### Task 6: `Mutator` guards — write-scope, optimistic version, validator hook

**Files:**
- Modify: none (behavior already implemented in Task 5 — this task adds the tests that lock it in)
- Test: `test/mutator-guards.test.ts`

- [ ] **Step 1: Write the failing test `test/mutator-guards.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator, type Validator } from "../src/mutator";
import { ScopeViolationError, StaleVersionError } from "../src/errors";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";
import { sizeBasedDecision } from "../src/decompose";

function setup(json: unknown, validate?: Validator) {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(5) };
  const tree = ArtifactTree.fromJson(json as never, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock, validate });
  return { tree, addressing, log, mutator };
}

describe("Mutator write-scope", () => {
  it("allows a write at or under the scope", () => {
    const { tree, mutator } = setup({ pages: [{ title: "Home" }] });
    mutator.set({ path: "/pages/0/title" }, "Hi", { writeScope: "/pages/0" });
    expect(tree.toJson()).toEqual({ pages: [{ title: "Hi" }] });
  });

  it("rejects a write outside the scope and leaves the tree and log untouched", () => {
    const { tree, log, mutator } = setup({ pages: [{ title: "Home" }, { title: "About" }] });
    expect(() => mutator.set({ path: "/pages/1/title" }, "X", { writeScope: "/pages/0" })).toThrow(
      ScopeViolationError,
    );
    expect(tree.toJson()).toEqual({ pages: [{ title: "Home" }, { title: "About" }] });
    expect(log.length()).toBe(0);
  });
});

describe("Mutator optimistic version", () => {
  it("applies when ifVersion matches", () => {
    const { tree, mutator } = setup({ a: 1 });
    mutator.set({ path: "/a" }, 2, { ifVersion: 0 });
    expect(tree.toJson()).toEqual({ a: 2 });
  });

  it("rejects when ifVersion is stale and records nothing", () => {
    const { tree, log, mutator } = setup({ a: 1 });
    mutator.set({ path: "/a" }, 2); // bumps version to 1
    expect(() => mutator.set({ path: "/a" }, 3, { ifVersion: 0 })).toThrow(StaleVersionError);
    expect(tree.toJson()).toEqual({ a: 2 });
    expect(log.length()).toBe(1);
  });
});

describe("Mutator validator hook", () => {
  it("blocks a mutation when the validator throws, leaving tree and log untouched", () => {
    const validate: Validator = ({ proposed }) => {
      if (proposed === "bad") throw new Error("rejected by validator");
    };
    const { tree, log, mutator } = setup({ a: "ok" }, validate);
    expect(() => mutator.set({ path: "/a" }, "bad")).toThrow("rejected by validator");
    expect(tree.toJson()).toEqual({ a: "ok" });
    expect(log.length()).toBe(0);
  });

  it("allows a mutation the validator accepts", () => {
    const validate: Validator = ({ proposed }) => {
      if (proposed === "bad") throw new Error("rejected");
    };
    const { tree, mutator } = setup({ a: "ok" }, validate);
    mutator.set({ path: "/a" }, "fine");
    expect(tree.toJson()).toEqual({ a: "fine" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `npx vitest run test/mutator-guards.test.ts`
Expected: PASS — the guards were implemented in Task 5. (If any test fails, fix the corresponding guard in `src/mutator.ts` — `checkScope`/`checkVersion`/`validate` ordering must run BEFORE any tree mutation so a rejected op records nothing.)

> Note: This task is test-only because Task 5 already implemented the guards. Writing these tests separately keeps each behavior explicitly locked in. The "verify it fails first" TDD step does not apply when hardening already-built behavior; the meaningful check here is that the guards reject *before* mutating (no partial writes, no log entries).

- [ ] **Step 3: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add test/mutator-guards.test.ts
git commit -m "test: lock in Mutator scope/version/validator guards"
```

---

### Task 7: `Mutator` — `move` + `transaction`

**Files:**
- Modify: `src/mutator.ts` (add `move` and `transaction` methods to the `Mutator` class)
- Test: `test/mutator-move-tx.test.ts`

- [ ] **Step 1: Write the failing test `test/mutator-move-tx.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";
import { sizeBasedDecision } from "../src/decompose";

function setup(json: unknown) {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(5) };
  const tree = ArtifactTree.fromJson(json as never, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock });
  return { tree, addressing, log, mutator };
}

describe("Mutator.move", () => {
  it("moves a node to a new parent, preserves its id, updates its path, and logs from/to", () => {
    const { tree, addressing, log, mutator } = setup({ from: ["a", "b"], to: ["c"] });
    const aId = addressing.byPath("/from/0")!.id;
    mutator.move({ id: aId }, { path: "/to" }, 1);
    expect(tree.toJson()).toEqual({ from: ["b"], to: ["c", "a"] });
    expect(addressing.byId(aId)!.id).toBe(aId); // identity preserved
    expect(addressing.pathOf(aId)).toBe("/to/1"); // path now derived from new location
    const e = log.entries()[0];
    expect(e.kind).toBe("move");
    expect(e.targetId).toBe(aId);
    expect(e.to).toEqual({ parentId: addressing.byPath("/to")!.id, key: 1 });
  });

  it("bumps the moved node and both parents", () => {
    const { tree, addressing, mutator } = setup({ from: ["a"], to: ["c"] });
    const aId = addressing.byPath("/from/0")!.id;
    const fromId = addressing.byPath("/from")!.id;
    const toId = addressing.byPath("/to")!.id;
    mutator.move({ id: aId }, { path: "/to" }, 1);
    expect(tree.get(aId)!.meta.version).toBe(1);
    expect(tree.get(fromId)!.meta.version).toBe(1);
    expect(tree.get(toId)!.meta.version).toBe(1);
  });
});

describe("Mutator.transaction", () => {
  it("applies all ops when the function completes", () => {
    const { tree, mutator } = setup({ a: 1 });
    mutator.transaction(() => {
      mutator.insert({ path: "" }, "b", 2);
      mutator.set({ path: "/a" }, 10);
    });
    expect(tree.toJson()).toEqual({ a: 10, b: 2 });
  });

  it("rolls back the tree and the log when the function throws", () => {
    const { tree, log, mutator } = setup({ a: 1 });
    expect(() =>
      mutator.transaction(() => {
        mutator.insert({ path: "" }, "b", 2);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(tree.toJson()).toEqual({ a: 1 }); // insert rolled back
    expect(log.length()).toBe(0); // log truncated
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mutator-move-tx.test.ts`
Expected: FAIL — `mutator.move is not a function` (and `transaction`).

- [ ] **Step 3: Modify `src/mutator.ts`**

Add these two methods INSIDE the `Mutator` class, before its closing brace (after `remove`):

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
    this.tree.moveNode(node.id, toParent.id, keyOrIndex);
    // bump moved node + both parents (dedupe if old === new parent)
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
      actor: opts.owner,
      ts: this.deps.clock.now(),
    });
  }

  /** Run `fn` atomically: if it throws, the tree and log are restored to their pre-transaction state. */
  transaction(fn: () => void): void {
    const snap = this.tree.snapshot();
    const logLen = this.log.length();
    try {
      fn();
    } catch (err) {
      this.tree.restore(snap);
      this.log.truncateTo(logLen);
      throw err;
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/mutator-move-tx.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all suites pass; no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/mutator.ts test/mutator-move-tx.test.ts
git commit -m "feat: Mutator move op and atomic transaction"
```

---

## Milestone 2 — Definition of Done

- [ ] `npm test` — all suites pass (M1 + M2).
- [ ] `npm run typecheck` — no errors.
- [ ] You can: resolve a node by `{id}` or `{path}`; `set`/`insert`/`remove`/`move` through the `Mutator`; every op bumps versions and appends a reversible `MutationEvent`; writes outside `writeScope` and stale `ifVersion` are rejected with typed errors *before* any change; a thrown `transaction` leaves the tree and log exactly as before.

---

## Roadmap: subsequent plans

- **M3 — Schema-optional:** type registry + Zod-adapter `Validator`, wired into the `Mutator.deps.validate` hook (already present); decompose type-override.
- **M4 — Navigator + exact index**, **M5 — Semantic index**, **M6 — Storage**, **M7 — Replay/time-travel** (consumes the reversible events from this milestone), **M8 — Toolset**, **M9 — Scenario/e2e**. (See the M1 plan roadmap for details.)

---

## Self-Review (against the spec)

**Spec coverage (this plan):** §8 mutations `set`/`insert`/`remove`/`move` → Tasks 3–5, 7. Reversible event-log (`before`+`after`) → Task 2 + recording in Tasks 5, 7. `meta.version`/`updatedAt`/`owner` bump → Task 5 (`bump`), rules in Design Decision 6. Scope check → Task 5/6 (`checkScope`). Optimistic `ifVersion` → Task 5/6 (`checkVersion`, `StaleVersionError`). Validator hook (M3 seam) → Task 5/6. `transaction` atomicity → Task 7. Typed errors as structured results → Task 1 (thrown; toolset converts in M8). CRDT-readiness (id-anchored ops, not array index) → ops target stable ids; array `key` renumber keeps positions but identity is the id (Design Decision 1). Embedding stale-marking deliberately NOT touched (M5) — noted in Scope.

**Placeholder scan:** No TBD/TODO; every code step has full code; every run step has an exact command + expected result. Task 6 is explicitly test-only (guards built in Task 5) with the rationale stated — not a placeholder.

**Type consistency:** `Ref` (`{id}|{path}`) defined in Task 1, used in Tasks 5, 7. `MutationEvent`/`OpKind`/`EventLog` (`append`/`entries`/`since`/`length`/`truncateTo`) defined in Task 2, used in Tasks 5, 7. `ArtifactTree` primitives (`replaceValue`/`snapshot`/`restore` Task 3; `insertChild`/`removeChild`/`moveNode` Task 4) match their `Mutator` call sites in Tasks 5, 7. `TreeSnapshot` defined in Task 3, used by `snapshot`/`restore` and `transaction` (Task 7). `Mutator` constructor `(tree, addressing, log, deps)` and `MutatorDeps {clock, validate?}`, `MutateOpts {owner?, writeScope?, ifVersion?}`, `Validator` defined in Task 5, used consistently in Tasks 5–7. `InvalidOpError` imported into `artifact-tree.ts` (Task 3) and `mutator.ts` (Task 5) from `./errors`. Error class names (`NodeNotFoundError`/`ScopeViolationError`/`StaleVersionError`/`InvalidOpError`) consistent across Tasks 1, 5, 6, 7.
