# Arbor — M6: Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist a whole artifact — tree + event-log + vectors — through a pluggable `StoragePort` (in-memory and file-snapshot adapters), restore it into fresh components, and close the orphaned-vectors known issue so the vector index never drifts.

**Architecture:** A serializable `StoredArtifact` bundle (`{version, rootId, nodes[], events[], vectors[]}`) is the unit of persistence — every field is plain JSON. `serializeArtifact(tree, log, vectors)` dumps the live components into it; `restoreArtifact(stored, deps, vectors)` rebuilds a fresh `ArtifactTree` + `EventLog` and upserts the vectors. To support this, the components gain minimal serialization accessors (`ArtifactTree.allNodes()`/`fromStored()`, `EventLog.fromStored()`, `VectorIndexPort.entries()`). `StoragePort` has two adapters: `MemoryStorage` (holds a cloned bundle) and `FileStorage` (JSON file via `node:fs/promises`). Separately, the orphaned-vectors fix adds `ArtifactTree.descendantIds()` and makes `Mutator.set`/`remove` fire `onRemove` for every deleted descendant — so vectors of previously-indexed nodes don't linger when a parent is replaced/removed.

**Tech Stack:** Node ≥20.6, TypeScript (ESM, strict), Vitest. `node:fs/promises`/`node:os`/`node:path` for the file adapter (no new packages). Builds on M1–M5.

---

## Scope of THIS plan (Milestone 6)

Covers spec §10.6 (storage: in-memory + file-snapshot adapters, persist tree + vectors, restore; the event-log is persisted too, enabling M7 replay) and closes the M5 orphaned-vectors known issue. Produces working, testable software: save an artifact, reload it into fresh components, and search/navigate it identically.

**Out of scope here (later milestones):** SQLite/sqlite-vec & Postgres/pgvector adapters (the `StoragePort`/`VectorIndexPort` seams make them additive later), replay/`getAt`/`revert`/`diff` engine (M7 — it consumes the persisted event-log), the scoped `makeToolset` + LangChain wrappers (M8), the `Navigator.get` returns-`meta`-by-reference nit (M8 boundary). Also deferred: persisting the `SemanticIndex` stale queue (M6 assumes save happens after `reindex`, i.e. clean state; a restored index re-derives staleness via `reindex` if needed), and indexing decomposed descendant nodes of a set/insert (a separate semantic-coverage decision).

## Design decisions (locked for M6)

1. **`StoredArtifact` is plain JSON.** `ArbNode`, `MutationEvent`, and `{nodeId, vector}` are all JSON-serializable, so the bundle round-trips through `JSON.stringify`/`parse` and `structuredClone` without custom codecs. A `version: 1` field guards forward-compat.
2. **Components expose minimal serialization seams**, not a generic ORM: `ArtifactTree.allNodes()` + static `fromStored(nodes, rootId, deps)`, `EventLog.fromStored(events)` (preserving original `seq`), `VectorIndexPort.entries()`. `restoreArtifact` rebuilds tree+log and upserts vectors into a caller-provided index.
3. **`restoreArtifact` needs `TreeDeps`** (idGen/clock/decision) because the restored tree must accept future mutations; the restored vectors go into a `VectorIndexPort` the caller supplies (so the same `MemoryVectorIndex` can back a fresh `SemanticIndex`).
4. **Orphaned-vectors fix:** `Mutator.set` captures the target's descendant ids before `replaceValue` and fires `onRemove` for them after (they're replaced by new nodes); `Mutator.remove` fires `onRemove` for the node AND all its descendants. Leaf targets have no descendants → existing M5 hook tests stay green.
5. **No persistence of the stale queue.** Save after `reindex` (clean). A restored `SemanticIndex` starts with an empty stale set and the restored vectors — `search` works immediately; if nodes were stale at save time, call `reindex` after restore.

## File Structure (Milestone 6)

- Modify: `src/artifact-tree.ts` — add `allNodes()`, static `fromStored()`, `descendantIds()`.
- Modify: `src/event-log.ts` — add static `fromStored()`.
- Modify: `src/vector-index-port.ts` — add `entries()` to `VectorIndexPort` + `MemoryVectorIndex`.
- Create: `src/storage.ts` — `StoredArtifact`, `StoragePort`, `serializeArtifact`, `restoreArtifact`, `MemoryStorage`.
- Create: `src/file-storage.ts` — `FileStorage`.
- Modify: `src/mutator.ts` — `set`/`remove` fire `onRemove` for deleted descendants (orphaned-vectors fix).
- Test: `test/artifact-tree-serialize.test.ts`, `test/serialize-accessors.test.ts`, `test/storage.test.ts`, `test/file-storage.test.ts`, `test/mutator-orphans.test.ts`, `test/m6-storage.test.ts`.

---

### Task 1: `ArtifactTree` serialization + `descendantIds`

**Files:**
- Modify: `src/artifact-tree.ts` (add 3 members; no other method changes)
- Test: `test/artifact-tree-serialize.test.ts`

- [ ] **Step 1: Write the failing test `test/artifact-tree-serialize.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function deps(): TreeDeps {
  return { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
}
function make(json: unknown): ArtifactTree {
  return ArtifactTree.fromJson(json as never, deps());
}

describe("ArtifactTree.allNodes + fromStored", () => {
  it("allNodes returns every node and fromStored rebuilds an equivalent tree", () => {
    const tree = make({ a: { b: 1 }, c: 2 });
    const nodes = tree.allNodes();
    expect(nodes.length).toBe(tree.size());
    const rebuilt = ArtifactTree.fromStored(nodes, tree.rootIdValue(), deps());
    expect(rebuilt.toJson()).toEqual(tree.toJson());
    expect(rebuilt.rootIdValue()).toBe(tree.rootIdValue());
  });

  it("fromStored preserves node ids (a stored id resolves in the rebuilt tree)", () => {
    const tree = make({ a: "x" });
    const aId = tree.children(tree.rootIdValue())[0].id;
    const rebuilt = ArtifactTree.fromStored(tree.allNodes(), tree.rootIdValue(), deps());
    expect(rebuilt.get(aId)!.content).toBe("x");
  });
});

describe("ArtifactTree.descendantIds", () => {
  it("lists all transitive descendants, not the node itself", () => {
    const tree = make({ a: { b: { c: 1 } } });
    const aId = tree.children(tree.rootIdValue())[0].id;
    const ids = tree.descendantIds(aId);
    expect(ids).not.toContain(aId);
    expect(ids.length).toBe(2); // b node + c leaf
    expect(ids.every((id) => tree.get(id) !== undefined)).toBe(true);
  });

  it("returns empty for a leaf", () => {
    const tree = make({ a: "x" });
    const aId = tree.children(tree.rootIdValue())[0].id;
    expect(tree.descendantIds(aId)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/artifact-tree-serialize.test.ts`
Expected: FAIL — `allNodes`/`fromStored`/`descendantIds` not defined.

- [ ] **Step 3: Modify `src/artifact-tree.ts`**

Add these members INSIDE the `ArtifactTree` class, before its closing brace (after the existing methods). Do not modify any existing method:

```ts
  /** All nodes in the tree (for serialization). */
  allNodes(): ArbNode[] {
    return [...this.nodes.values()];
  }

  /** Rebuild a tree from previously serialized nodes, preserving their ids. */
  static fromStored(nodes: ArbNode[], rootId: NodeId, deps: TreeDeps): ArtifactTree {
    const tree = new ArtifactTree(deps);
    for (const node of nodes) tree.nodes.set(node.id, node);
    tree.rootId = rootId;
    return tree;
  }

  /** All transitive descendant ids of `id` (depth-first), excluding `id` itself. */
  descendantIds(id: NodeId): NodeId[] {
    const out: NodeId[] = [];
    const node = this.nodes.get(id);
    if (!node) return out;
    for (const cid of node.childIds) {
      out.push(cid);
      out.push(...this.descendantIds(cid));
    }
    return out;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/artifact-tree-serialize.test.ts`
Expected: PASS (4 tests). Then `npx vitest run` — no regressions.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/artifact-tree.ts test/artifact-tree-serialize.test.ts
git commit -m "feat: ArtifactTree allNodes/fromStored + descendantIds"
```

---

### Task 2: `EventLog.fromStored` + `VectorIndexPort.entries`

**Files:**
- Modify: `src/event-log.ts` (add static `fromStored`)
- Modify: `src/vector-index-port.ts` (add `entries()` to interface + `MemoryVectorIndex`)
- Test: `test/serialize-accessors.test.ts`

- [ ] **Step 1: Write the failing test `test/serialize-accessors.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { EventLog } from "../src/event-log";
import { MemoryVectorIndex } from "../src/vector-index-port";

describe("EventLog.fromStored", () => {
  it("rebuilds a log from stored events, preserving seq and order", () => {
    const log = new EventLog();
    log.append({ kind: "set", targetId: "n1", parentId: "n0", key: "k", after: 1, ts: 0 });
    log.append({ kind: "remove", targetId: "n2", parentId: "n0", key: "j", before: 2, ts: 0 });
    const restored = EventLog.fromStored([...log.entries()]);
    expect(restored.length()).toBe(2);
    expect(restored.entries()).toEqual(log.entries());
  });

  it("a rebuilt log keeps appending from the right seq", () => {
    const log = new EventLog();
    log.append({ kind: "set", targetId: "n1", parentId: null, key: null, ts: 0 });
    const restored = EventLog.fromStored([...log.entries()]);
    const next = restored.append({ kind: "set", targetId: "n2", parentId: null, key: null, ts: 0 });
    expect(next.seq).toBe(1);
  });
});

describe("MemoryVectorIndex.entries", () => {
  it("dumps all entries, round-trippable via upsert", () => {
    const idx = new MemoryVectorIndex();
    idx.upsert([
      { nodeId: "a", vector: [1, 0] },
      { nodeId: "b", vector: [0, 1] },
    ]);
    const entries = idx.entries();
    expect(entries.length).toBe(2);
    const idx2 = new MemoryVectorIndex();
    idx2.upsert(entries);
    expect(idx2.size()).toBe(2);
    expect(idx2.has("a")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/serialize-accessors.test.ts`
Expected: FAIL — `EventLog.fromStored` / `MemoryVectorIndex.entries` not defined.

- [ ] **Step 3: Modify `src/event-log.ts`**

Add this static method INSIDE the `EventLog` class, before its closing brace (after `truncateTo`):

```ts
  /** Rebuild a log from previously serialized events, preserving their seq. */
  static fromStored(events: MutationEvent[]): EventLog {
    const log = new EventLog();
    for (const e of events) log.events.push({ ...e });
    return log;
  }
```

- [ ] **Step 4: Modify `src/vector-index-port.ts`**

Add `entries()` to the `VectorIndexPort` interface (after `size(): number;`):

```ts
  entries(): VectorIndexEntry[];
```

Add the `entries()` method INSIDE `MemoryVectorIndex`, before its closing brace (after `search`):

```ts
  entries(): VectorIndexEntry[] {
    return [...this.vectors].map(([nodeId, vector]) => ({ nodeId, vector }));
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/serialize-accessors.test.ts`
Expected: PASS (3 tests). Then `npx vitest run` — no regressions.

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/event-log.ts src/vector-index-port.ts test/serialize-accessors.test.ts
git commit -m "feat: EventLog.fromStored + VectorIndexPort.entries (serialization accessors)"
```

---

### Task 3: `storage.ts` — `StoragePort`, serialize/restore, `MemoryStorage`

**Files:**
- Create: `src/storage.ts`
- Test: `test/storage.test.ts`

- [ ] **Step 1: Write the failing test `test/storage.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { serializeArtifact, restoreArtifact, MemoryStorage } from "../src/storage";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function build() {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson({ docs: {} }, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock });
  const aId = mutator.insert({ path: "/docs" }, "a", "hello");
  const vectors = new MemoryVectorIndex();
  vectors.upsert([{ nodeId: aId, vector: [1, 2, 3] }]);
  return { tree, log, vectors, aId };
}

function freshDeps(): TreeDeps {
  return { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
}

describe("serializeArtifact", () => {
  it("dumps the live components into a versioned StoredArtifact", () => {
    const { tree, log, vectors } = build();
    const s = serializeArtifact(tree, log, vectors);
    expect(s.version).toBe(1);
    expect(s.rootId).toBe(tree.rootIdValue());
    expect(s.nodes.length).toBe(tree.size());
    expect(s.events.length).toBe(log.length());
    expect(s.vectors.length).toBe(1);
  });
});

describe("MemoryStorage + restoreArtifact", () => {
  it("load returns null before any save", async () => {
    expect(await new MemoryStorage().load()).toBeNull();
  });

  it("round-trips and restores identical tree, events, and vectors", async () => {
    const { tree, log, vectors, aId } = build();
    const store = new MemoryStorage();
    await store.save(serializeArtifact(tree, log, vectors));
    const loaded = (await store.load())!;
    const freshVectors = new MemoryVectorIndex();
    const { tree: rtree, log: rlog } = restoreArtifact(loaded, freshDeps(), freshVectors);
    expect(rtree.toJson()).toEqual(tree.toJson());
    expect(rlog.entries()).toEqual(log.entries());
    expect(freshVectors.has(aId)).toBe(true);
    expect(rtree.get(aId)!.content).toBe("hello");
  });

  it("the saved bundle is independent of later mutations to the live components", async () => {
    const { tree, log, vectors } = build();
    const store = new MemoryStorage();
    await store.save(serializeArtifact(tree, log, vectors));
    vectors.upsert([{ nodeId: "later", vector: [9, 9, 9] }]);
    const loaded = (await store.load())!;
    expect(loaded.vectors.length).toBe(1); // snapshot not affected by later upsert
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/storage.test.ts`
Expected: FAIL — cannot resolve `../src/storage`.

- [ ] **Step 3: Write `src/storage.ts`**

```ts
import type { ArbNode, NodeId } from "./types";
import { ArtifactTree, type TreeDeps } from "./artifact-tree";
import { EventLog, type MutationEvent } from "./event-log";
import type { VectorIndexPort, VectorIndexEntry } from "./vector-index-port";

/** A JSON-serializable snapshot of an entire artifact: tree + event-log + vectors. */
export interface StoredArtifact {
  version: 1;
  rootId: NodeId;
  nodes: ArbNode[];
  events: MutationEvent[];
  vectors: VectorIndexEntry[];
}

/** Persists/loads a StoredArtifact. Adapters: MemoryStorage, FileStorage (and DB-backed later). */
export interface StoragePort {
  save(artifact: StoredArtifact): Promise<void>;
  load(): Promise<StoredArtifact | null>;
}

/** Dump the live components into a StoredArtifact. */
export function serializeArtifact(tree: ArtifactTree, log: EventLog, vectors: VectorIndexPort): StoredArtifact {
  return {
    version: 1,
    rootId: tree.rootIdValue(),
    nodes: tree.allNodes(),
    events: [...log.entries()],
    vectors: vectors.entries(),
  };
}

/** Rebuild a fresh tree + log from a StoredArtifact, and upsert its vectors into `vectors`. */
export function restoreArtifact(
  stored: StoredArtifact,
  deps: TreeDeps,
  vectors: VectorIndexPort,
): { tree: ArtifactTree; log: EventLog } {
  const tree = ArtifactTree.fromStored(stored.nodes, stored.rootId, deps);
  const log = EventLog.fromStored(stored.events);
  vectors.upsert(stored.vectors);
  return { tree, log };
}

/** In-memory StoragePort: holds a deep-cloned bundle. */
export class MemoryStorage implements StoragePort {
  private stored: StoredArtifact | null = null;

  async save(artifact: StoredArtifact): Promise<void> {
    this.stored = structuredClone(artifact);
  }

  async load(): Promise<StoredArtifact | null> {
    return this.stored ? structuredClone(this.stored) : null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/storage.test.ts`
Expected: PASS (4 tests). Then `npx vitest run` — no regressions.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/storage.ts test/storage.test.ts
git commit -m "feat: StoragePort + serialize/restore + MemoryStorage"
```

---

### Task 4: `FileStorage`

**Files:**
- Create: `src/file-storage.ts`
- Test: `test/file-storage.test.ts`

- [ ] **Step 1: Write the failing test `test/file-storage.test.ts`**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileStorage } from "../src/file-storage";
import type { StoredArtifact } from "../src/storage";

const path = join(tmpdir(), "arbor-m6-file-storage.test.json");

function sample(): StoredArtifact {
  return {
    version: 1,
    rootId: "n0",
    nodes: [
      { id: "n0", parentId: null, key: null, kind: "leaf", content: "x", childIds: [], meta: { version: 0, updatedAt: 0, embedding: { state: "none" } } },
    ],
    events: [],
    vectors: [{ nodeId: "n0", vector: [1, 2] }],
  };
}

describe("FileStorage", () => {
  afterEach(async () => {
    await rm(path, { force: true });
  });

  it("load returns null when the file does not exist", async () => {
    expect(await new FileStorage(path).load()).toBeNull();
  });

  it("round-trips a saved artifact through a JSON file", async () => {
    const store = new FileStorage(path);
    const a = sample();
    await store.save(a);
    expect(await store.load()).toEqual(a);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/file-storage.test.ts`
Expected: FAIL — cannot resolve `../src/file-storage`.

- [ ] **Step 3: Write `src/file-storage.ts`**

```ts
import { readFile, writeFile } from "node:fs/promises";
import type { StoredArtifact, StoragePort } from "./storage";

/** File-backed StoragePort: one JSON file per artifact. `load` returns null if the file is absent. */
export class FileStorage implements StoragePort {
  constructor(private readonly path: string) {}

  async save(artifact: StoredArtifact): Promise<void> {
    await writeFile(this.path, JSON.stringify(artifact), "utf8");
  }

  async load(): Promise<StoredArtifact | null> {
    try {
      const text = await readFile(this.path, "utf8");
      return JSON.parse(text) as StoredArtifact;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/file-storage.test.ts`
Expected: PASS (2 tests). Then `npx vitest run` — no regressions.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/file-storage.ts test/file-storage.test.ts
git commit -m "feat: FileStorage (JSON file StoragePort)"
```

---

### Task 5: Orphaned-vectors fix — `Mutator` cleans up deleted descendants

**Files:**
- Modify: `src/mutator.ts` (replace `set` and `remove`; no other change)
- Test: `test/mutator-orphans.test.ts`

- [ ] **Step 1: Write the failing test `test/mutator-orphans.test.ts`**

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
  const removed: string[] = [];
  const mutator = new Mutator(tree, addressing, log, { clock, onRemove: (id) => removed.push(id) });
  return { tree, addressing, mutator, removed };
}

describe("Mutator orphaned-descendant cleanup", () => {
  it("remove fires onRemove for the node AND all its descendants", () => {
    const { addressing, mutator, removed } = setup({ docs: { a: { x: "1" } } });
    const aId = addressing.byPath("/docs/a")!.id;
    const xId = addressing.byPath("/docs/a/x")!.id;
    removed.length = 0;
    mutator.remove({ id: aId });
    expect(removed).toContain(aId);
    expect(removed).toContain(xId);
  });

  it("set on a container fires onRemove for the replaced (old) descendants", () => {
    const { addressing, mutator, removed } = setup({ docs: { a: { x: "1" } } });
    const aId = addressing.byPath("/docs/a")!.id;
    const xId = addressing.byPath("/docs/a/x")!.id;
    removed.length = 0;
    mutator.set({ id: aId }, { y: "2" });
    expect(removed).toContain(xId);
  });

  it("set on a leaf (no descendants) fires no onRemove", () => {
    const { addressing, mutator, removed } = setup({ a: "x" });
    const aId = addressing.byPath("/a")!.id;
    removed.length = 0;
    mutator.set({ id: aId }, "y");
    expect(removed).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mutator-orphans.test.ts`
Expected: FAIL — `remove` currently fires `onRemove` only for the top node; `set` fires none.

- [ ] **Step 3: Modify `src/mutator.ts`**

Replace the existing `set` method with (captures descendant ids before `replaceValue`, fires `onRemove` for them after):

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
      before,
      after: value,
      actor: opts.owner,
      ts: this.deps.clock.now(),
    });
  }
```

Replace the existing `remove` method with (fires `onRemove` for the node AND its descendants):

```ts
  remove(ref: Ref, opts: MutateOpts = {}): void {
    const node = this.resolve(ref);
    if (node.parentId === null) throw new InvalidOpError("cannot remove the root");
    this.checkScope(node, opts.writeScope);
    this.checkVersion(node, opts.ifVersion);
    const before = this.tree.toJson(node.id);
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
      before,
      actor: opts.owner,
      ts: this.deps.clock.now(),
    });
  }
```

(Do NOT modify `insert`/`move`/`transaction`/guards. `descendantIds` must be read BEFORE the structural mutation, while the subtree still exists.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/mutator-orphans.test.ts`
Expected: PASS (3 tests). Then `npx vitest run` — confirm NO regressions. In particular the M5 `mutator-hooks.test.ts` "remove fires onRemove with the removed node id" expects `[id]` for a **leaf** target (no descendants → still `[id]`), so it stays green.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/mutator.ts test/mutator-orphans.test.ts
git commit -m "fix: Mutator fires onRemove for deleted descendants (no orphaned vectors)"
```

---

### Task 6: Capstone — persist an indexed artifact and search it after restore

**Files:**
- Test: `test/m6-storage.test.ts` (test-only; full round-trip incl. semantic search on restored vectors)

- [ ] **Step 1: Write the failing test `test/m6-storage.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { SemanticIndex } from "../src/semantic-index";
import { MockEmbeddingPort } from "../src/embedding-port";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { serializeArtifact, restoreArtifact, MemoryStorage } from "../src/storage";
import { FileStorage } from "../src/file-storage";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function buildAndIndex() {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson({ docs: {} }, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const vectors = new MemoryVectorIndex();
  const index = new SemanticIndex(tree, addressing, new MockEmbeddingPort(), vectors);
  const mutator = new Mutator(tree, addressing, log, { clock, ...index.hooks() });
  return { tree, log, vectors, index, mutator };
}

function freshDeps(): TreeDeps {
  return { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
}

describe("M6 storage round-trip", () => {
  it("MemoryStorage: restores tree+events+vectors so semantic search works without reindexing", async () => {
    const orig = buildAndIndex();
    orig.mutator.insert({ path: "/docs" }, "a", "the quick brown fox");
    orig.mutator.insert({ path: "/docs" }, "b", "lorem ipsum");
    await orig.index.reindex();

    const store = new MemoryStorage();
    await store.save(serializeArtifact(orig.tree, orig.log, orig.vectors));
    const loaded = (await store.load())!;

    const freshVectors = new MemoryVectorIndex();
    const { tree: rtree, log: rlog } = restoreArtifact(loaded, freshDeps(), freshVectors);
    const rindex = new SemanticIndex(rtree, new Addressing(rtree), new MockEmbeddingPort(), freshVectors);

    expect(rtree.toJson()).toEqual(orig.tree.toJson());
    expect(rlog.entries()).toEqual(orig.log.entries());

    const r = await rindex.search("the quick brown fox");
    expect(r.results[0].path).toBe("/docs/a");
    expect(r.staleCount).toBe(0);
  });

  it("FileStorage: round-trips the same bundle through a JSON file", async () => {
    const orig = buildAndIndex();
    orig.mutator.insert({ path: "/docs" }, "a", "hello world");
    await orig.index.reindex();
    const path = join(tmpdir(), "arbor-m6-capstone.test.json");
    const store = new FileStorage(path);
    try {
      await store.save(serializeArtifact(orig.tree, orig.log, orig.vectors));
      const loaded = (await store.load())!;
      const freshVectors = new MemoryVectorIndex();
      const { tree: rtree } = restoreArtifact(loaded, freshDeps(), freshVectors);
      expect(rtree.toJson()).toEqual(orig.tree.toJson());
      expect(freshVectors.size()).toBe(orig.vectors.size());
    } finally {
      await rm(path, { force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `npx vitest run test/m6-storage.test.ts`
Expected: PASS — every piece was built in Tasks 1–5. (If it fails, fix the corresponding source from the earlier task, not this test.)

- [ ] **Step 3: Run the full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all suites pass; no type errors.

- [ ] **Step 4: Commit**

```bash
git add test/m6-storage.test.ts
git commit -m "test: M6 storage end-to-end (persist tree+events+vectors, search after restore)"
```

---

## Milestone 6 — Definition of Done

- [ ] `npm test` — all suites pass (M1–M6).
- [ ] `npm run typecheck` — no errors.
- [ ] You can: `serializeArtifact(tree, log, vectors)` → `StoragePort.save` (in-memory or file) → `load` → `restoreArtifact(stored, deps, freshVectors)` yields a tree + log identical to the original, and a `SemanticIndex` over the restored vectors searches without reindexing. A `set`/`remove` of a parent no longer leaves orphaned vectors (the index is notified of every deleted descendant).

---

## Roadmap: subsequent plans

- **M7 — Replay / time-travel:** consumes the now-persistable event-log — `getAt(ref, version)`, full-tree reconstruction from nearest snapshot/checkpoint, `revert(ref, toVersion)`, `diff(vA, vB)`.
- **M8 — Toolset** (scoped `makeToolset` exposing describe/get/search/find/patch/history; serialize `meta` at the boundary), **M9 — Scenario**. Future storage adapters (SQLite+sqlite-vec, Postgres+pgvector) drop in behind `StoragePort`/`VectorIndexPort`.

---

## Self-Review (against the spec)

**Spec coverage (this plan):** §10.6 storage — serializable `StoredArtifact` (tree nodes + event-log + vectors) → Task 3; `StoragePort` → Task 3; in-memory adapter → Task 3 (`MemoryStorage`); file-snapshot adapter → Task 4 (`FileStorage`); restore → Task 3 (`restoreArtifact`); serialization seams on the components → Tasks 1–2. The M5 orphaned-vectors known issue → Task 5. End-to-end (persist an indexed artifact, search after restore) → Task 6. Deferred items (DB adapters, replay, toolset, stale-queue persistence, descendant indexing) listed in Scope.

**Placeholder scan:** No TBD/TODO; every code step has full code; every run step has an exact command + expected result. Task 6 step 2 is a "should already pass" capstone with rationale (not a placeholder).

**Type consistency:** `StoredArtifact {version:1; rootId:NodeId; nodes:ArbNode[]; events:MutationEvent[]; vectors:VectorIndexEntry[]}` defined in Task 3, produced by `serializeArtifact` and consumed by `restoreArtifact` (Task 3), `MemoryStorage` (Task 3), `FileStorage` (Task 4), capstone (Task 6). `ArtifactTree.allNodes()`/`fromStored(nodes, rootId, deps)`/`descendantIds(id)` defined in Task 1, used by `serializeArtifact`/`restoreArtifact` (Task 3) and `Mutator` (Task 5). `EventLog.fromStored(events)` (Task 2) used by `restoreArtifact`. `VectorIndexPort.entries(): VectorIndexEntry[]` (Task 2) used by `serializeArtifact`; `VectorIndexEntry` is the existing M5 type. `restoreArtifact(stored, deps: TreeDeps, vectors: VectorIndexPort)` returns `{tree, log}` — consistent across Tasks 3 and 6. `MutateOpts`/`onRemove` are the existing M5 `MutatorDeps` hook; Task 5 fires it for descendant ids via `descendantIds` (Task 1). `structuredClone` is a Node global (already used by `ArtifactTree.snapshot` in M2).
