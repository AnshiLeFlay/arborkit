# Arbor — M13: Delta Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop rewriting the whole artifact on every save. Add an appendable `DeltaStoragePort` (a periodic full **checkpoint** + an append-only **journal** of events after it) and a **forward** event-apply, so a routine save costs O(new events) instead of O(whole artifact). Restore = load the checkpoint and forward-replay the journal — preserving node types and the vectors of unchanged nodes.

**Architecture:** The reverse of M7's `reverseApplyValue` is a *forward* apply. Rather than a value-level redo (which would lose node types and vectors on restore), M13 forward-replays journaled events **through the `Mutator`**, addressed by each event's stable `path` (ids drift across re-decomposition, paths don't). This reuses decomposition, typing (via each event's `nodeType`), and the index hooks exactly as in normal operation: unchanged nodes keep their ids + checkpoint vectors; touched nodes are re-decomposed and marked stale for the consumer to reindex; removed nodes' vectors are dropped. Writes split into `appendEvents` (cheap, the common path) and `writeCheckpoint` (occasional full snapshot that clears the journal). Pairs with M12: `log.compactTo(...)` before a checkpoint keeps the checkpoint's embedded event window small.

**Tech Stack:** Node ≥20.6, TypeScript (ESM, strict), Vitest. No new dependencies. Builds on M1–M12 (262 tests). Reuses `serializeArtifact`/`restoreArtifact` (storage), `FileStorage` (atomic checkpoint file), `Mutator`/`Addressing`/`EventLog`.

---

## Scope of THIS plan (Milestone 13)

Review item #3 ("delta persistence — append-only event journal + forward-apply restore instead of whole-artifact rewrite"). Produces: a forward event-apply primitive, an appendable `DeltaStoragePort` (in-memory + file), and `persistDelta`/`persistCheckpoint`/`restoreFromDelta` orchestration — all back-compatible (the existing `StoragePort` / `serializeArtifact` / `restoreArtifact` are untouched and remain the simple default).

**Out of scope (later):** a checkpoint *policy* (when to re-snapshot) — the core ships the primitives + a documented pattern; the consumer (downstream `ArborRun`) decides cadence. Also out: DB-backed delta ports (SQLite/Postgres), CRDT, tag/type indexes, `stats()`/`subscribe`.

## Design decisions (locked for M13)

1. **Forward apply goes through the `Mutator`, addressed by `path`.** `applyEventForward(mutator, e)` maps one `MutationEvent` to the matching `Mutator` call (`set`/`insert`/`remove`/`move`) using `e.path`/`e.fromPath`/`e.toPath` and `e.key`/`e.to.key`, and re-applies the node type via `e.nodeType`. This preserves types and re-runs decomposition; node ids for touched subtrees are regenerated (same as live mutation), but the log/replay are path-addressed so this is invisible to consumers.
2. **Restore preserves unchanged vectors; reconciles the rest via the Mutator hooks.** `restoreFromDelta` restores the checkpoint (tree + log + vectors), then forward-replays the journal through a `Mutator` whose `onRemove` drops a removed/orphaned node's vector and whose `onChange` marks a touched node `embedding.state: "stale"`. Unchanged nodes keep their checkpoint vectors and `fresh` state; touched nodes are left stale for the consumer's existing `SemanticIndex` reindex flow (M10 seeds `stale` from `meta.embedding.state` on construction).
3. **The faithful log is rebuilt from stored events, not from the replay.** Replay uses a throwaway `EventLog`; the returned log is `EventLog.fromStored([...checkpoint.events, ...journal], checkpoint.baseSeq ?? 0)` — so event content (original ts/ids/before-values) and the M12 compaction floor survive the round-trip. Seqs are contiguous: checkpoint covers `[baseSeq, V)`, journal covers `[V, now)`.
4. **The journal is crash-tolerant by construction.** `loadDelta` drops journal events with `seq < checkpointVersion` (so `writeCheckpoint`-then-clear is safe even if the clear is lost), and a torn final journal line (crash mid-append) is treated as a truncated tail and ignored. The checkpoint file itself reuses `FileStorage` (atomic tmp+rename + shape validation).
5. **`DeltaStoragePort` is a NEW, separate interface — `StoragePort` is unchanged.** Delta persistence is opt-in; consumers that don't need it keep using `save`/`load`. No change to `storage.ts` types, `serializeArtifact`, or `restoreArtifact`.

## Constraints (documented in README + restore docstring)

- **Restore must use the same `decompose` decision as the original run.** Unchanged (checkpoint) nodes keep their structure, but journal-touched nodes are re-decomposed during forward-replay — a different decision would reshard them. (Full-snapshot restore stores nodes verbatim and is immune; this is the delta tradeoff.)
- **Forward-replay does not re-validate.** The replay `Mutator` has no `validate` hook — journaled values were valid when recorded; restore applies them verbatim.
- **`persist` cost is bounded by deltas, but a checkpoint still serializes the whole tree** (+ its event window). Pair with `log.compactTo` to bound the window; very large *trees* still cost on checkpoint (delta-of-tree is future work).

## File structure (Milestone 13)

- Create: `src/delta-storage.ts` — `DeltaStoragePort`, `DeltaBundle`, `MemoryDeltaStorage`, `FileDeltaStorage`.
- Create: `src/delta.ts` — `applyEventForward`, `replayForward` (Task 1); `persistDelta`, `persistCheckpoint`, `restoreFromDelta` (Task 3).
- Modify: `src/index.ts` — barrel-export the two new modules.
- Modify: `README.md` — "Delta persistence" note + Status.
- Test: `test/m13-forward-apply.test.ts`, `test/m13-delta-storage.test.ts`, `test/m13-persist-restore.test.ts`, `test/m13-capstone.test.ts`.

### Reuse
- `reverseApplyValue` ([replay.ts](c:\code\tools\arbor\src\replay.ts)) — the structural mirror `applyEventForward` inverts (set→after, insert→insert after, remove→remove, move→to).
- `Mutator` ([mutator.ts](c:\code\tools\arbor\src\mutator.ts)) — the forward-apply engine (resolves by path, re-decomposes, types via `opts.type`, fires `onChange`/`onRemove`).
- `serializeArtifact`/`restoreArtifact`/`StoredArtifact` ([storage.ts](c:\code\tools\arbor\src\storage.ts)) — checkpoint dump/restore.
- `FileStorage` ([file-storage.ts](c:\code\tools\arbor\src\file-storage.ts)) — atomic+validated checkpoint file (composed by `FileDeltaStorage`).
- `EventLog.fromStored`/`since`/`length`/`baseSeqValue` (M12) — faithful log rebuild + delta slicing.

---

### Task 1: Forward event-apply primitive

**Files:**
- Create: `src/delta.ts`
- Modify: `src/index.ts`
- Test: `test/m13-forward-apply.test.ts`

- [ ] **Step 1: Write the failing test `test/m13-forward-apply.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { replayForward } from "../src/delta";
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

describe("M13 forward event-apply", () => {
  it("forward-replaying a log onto a fresh copy reproduces the final value", () => {
    const a = setup({ docs: {}, list: [] });
    a.mutator.insert({ path: "/docs" }, "a", "alpha");
    a.mutator.set({ path: "/docs/a" }, "ALPHA");
    a.mutator.insert({ path: "/list" }, 0, "x");
    a.mutator.insert({ path: "/list" }, 1, "y");
    a.mutator.remove({ path: "/list/0" });

    const b = setup({ docs: {}, list: [] });
    replayForward(b.mutator, a.log.entries());
    expect(b.tree.toJson()).toEqual(a.tree.toJson());
    expect(a.tree.toJson()).toEqual({ docs: { a: "ALPHA" }, list: ["y"] });
  });

  it("preserves node types via the event's nodeType", () => {
    const a = setup({ docs: {} });
    a.mutator.insert({ path: "/docs" }, "a", { body: "hi" }, { type: "doc" });
    const b = setup({ docs: {} });
    replayForward(b.mutator, a.log.entries());
    expect(b.addressing.byPath("/docs/a")!.type).toBe("doc");
  });

  it("reproduces a move", () => {
    const a = setup({ a: { x: "1" }, b: {} });
    a.mutator.move({ path: "/a/x" }, { path: "/b" }, "x");
    const b = setup({ a: { x: "1" }, b: {} });
    replayForward(b.mutator, a.log.entries());
    expect(b.tree.toJson()).toEqual({ a: {}, b: { x: "1" } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/m13-forward-apply.test.ts`
Expected: FAIL — cannot import `replayForward` from `../src/delta` (module does not exist).

- [ ] **Step 3: Create `src/delta.ts`**

```ts
import type { MutationEvent } from "./event-log";
import { Mutator } from "./mutator";

/** The JSON-Pointer of the parent container of `pointer` ("" = root). Pointer
 *  separators are literal "/"; an in-key "/" is escaped "~1", so lastIndexOf is safe. */
function parentPointer(pointer: string): string {
  const i = pointer.lastIndexOf("/");
  return i <= 0 ? "" : pointer.slice(0, i);
}

/**
 * Re-apply ONE recorded event FORWARD onto a live tree via the `Mutator`, addressed by
 * the event's stable path(s). The inverse of replay's `reverseApplyValue`: set→`after`,
 * insert→insert `after`, remove→remove, move→to. Goes through the Mutator so
 * decomposition, typing (via `e.nodeType`), and the index hooks run exactly as in normal
 * operation. Node ids for touched subtrees are regenerated; the log/replay are
 * path-addressed, so that is invisible to consumers. Malformed/pre-M7 events (missing
 * paths) are skipped.
 */
export function applyEventForward(mutator: Mutator, e: MutationEvent): void {
  switch (e.kind) {
    case "set":
      if (e.path === undefined) return;
      mutator.set({ path: e.path }, e.after ?? null, e.nodeType === undefined ? {} : { type: e.nodeType });
      return;
    case "insert":
      if (e.path === undefined || e.key === null) return;
      mutator.insert(
        { path: parentPointer(e.path) },
        e.key,
        e.after ?? null,
        e.nodeType === undefined ? {} : { type: e.nodeType },
      );
      return;
    case "remove":
      if (e.path === undefined) return;
      mutator.remove({ path: e.path });
      return;
    case "move":
      if (e.fromPath === undefined || e.toPath === undefined || !e.to || e.to.key === null) return;
      mutator.move({ path: e.fromPath }, { path: parentPointer(e.toPath) }, e.to.key);
      return;
  }
}

/** Forward-apply a sequence of events, in order. */
export function replayForward(mutator: Mutator, events: readonly MutationEvent[]): void {
  for (const e of events) applyEventForward(mutator, e);
}
```

- [ ] **Step 4: Barrel-export the module.** In `src/index.ts`, add after the `export * from "./replay";` line:

```ts
export * from "./delta";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/m13-forward-apply.test.ts`
Expected: PASS (3 tests). Then `npx vitest run` — no regressions (new module, nothing else touched; barrel just gains two exports with no name collisions).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck` (clean), then:

```bash
git add src/delta.ts src/index.ts test/m13-forward-apply.test.ts
git commit -m "feat: forward event-apply (applyEventForward/replayForward via Mutator, path-addressed)"
```

---

### Task 2: Appendable DeltaStoragePort (memory + file)

**Files:**
- Create: `src/delta-storage.ts`
- Modify: `src/index.ts`
- Test: `test/m13-delta-storage.test.ts`

- [ ] **Step 1: Write the failing test `test/m13-delta-storage.test.ts`**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { MemoryDeltaStorage, FileDeltaStorage } from "../src/delta-storage";
import type { StoredArtifact } from "../src/storage";
import type { MutationEvent } from "../src/event-log";

const dir = mkdtempSync(join(tmpdir(), "arbor-m13-"));

// A minimal checkpoint whose embedded events cover seqs [0, n).
function checkpoint(events: number[]): StoredArtifact {
  return {
    version: 2,
    rootId: "n0",
    nodes: [{ id: "n0", parentId: null, key: null, kind: "object", content: null, childIds: [], meta: { version: 0, updatedAt: 0, embedding: { state: "none" } } }],
    events: events.map((seq) => ev(seq)),
    baseSeq: events.length ? events[0] : 0,
    vectors: [],
  };
}
function ev(seq: number): MutationEvent {
  return { seq, kind: "set", targetId: "n0", parentId: null, key: "k", path: "/k", after: seq, ts: 0 };
}

describe("M13 DeltaStoragePort", () => {
  afterEach(async () => {
    await rm(join(dir, "cp.json"), { force: true });
    await rm(join(dir, "journal.ndjson"), { force: true });
  });

  for (const make of [
    () => new MemoryDeltaStorage(),
    () => new FileDeltaStorage(join(dir, "cp.json"), join(dir, "journal.ndjson")),
  ]) {
    it(`${make().constructor.name}: load before any checkpoint → null + empty journal`, async () => {
      const s = make();
      expect(await s.loadDelta()).toEqual({ checkpoint: null, journal: [] });
    });

    it(`${make().constructor.name}: checkpoint + append → loadDelta returns both`, async () => {
      const s = make();
      await s.writeCheckpoint(checkpoint([0, 1])); // covers seqs 0,1 → version 2
      await s.appendEvents([ev(2), ev(3)]);
      const { checkpoint: cp, journal } = await s.loadDelta();
      expect(cp!.events.map((e) => e.seq)).toEqual([0, 1]);
      expect(journal.map((e) => e.seq)).toEqual([2, 3]);
    });

    it(`${make().constructor.name}: writeCheckpoint clears the journal`, async () => {
      const s = make();
      await s.writeCheckpoint(checkpoint([0]));
      await s.appendEvents([ev(1)]);
      await s.writeCheckpoint(checkpoint([0, 1, 2])); // version 3
      expect((await s.loadDelta()).journal).toEqual([]);
    });

    it(`${make().constructor.name}: stale pre-checkpoint journal events are filtered`, async () => {
      const s = make();
      await s.writeCheckpoint(checkpoint([0, 1, 2])); // version 3
      await s.appendEvents([ev(1), ev(2), ev(3), ev(4)]); // 1,2 are stale (< 3)
      expect((await s.loadDelta()).journal.map((e) => e.seq)).toEqual([3, 4]);
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/m13-delta-storage.test.ts`
Expected: FAIL — cannot import from `../src/delta-storage` (module does not exist).

- [ ] **Step 3: Create `src/delta-storage.ts`**

```ts
import { readFile, writeFile, appendFile } from "node:fs/promises";
import type { MutationEvent } from "./event-log";
import type { StoredArtifact } from "./storage";
import { FileStorage } from "./file-storage";

/** A checkpoint snapshot plus the events journaled after it. */
export interface DeltaBundle {
  checkpoint: StoredArtifact | null;
  journal: MutationEvent[];
}

/**
 * Append-oriented persistence: a periodic full **checkpoint** + an appendable **journal**
 * of events after it. `appendEvents` is O(new events) — the per-save win over `StoragePort`,
 * which rewrites the whole artifact. Restore = checkpoint + forward-replayed journal
 * (see `restoreFromDelta`). Opt-in and independent of `StoragePort`.
 */
export interface DeltaStoragePort {
  /** Replace the checkpoint and clear the journal (the new checkpoint already embeds
   *  every event up to its version). */
  writeCheckpoint(artifact: StoredArtifact): Promise<void>;
  /** Append events to the journal (O(events)). */
  appendEvents(events: readonly MutationEvent[]): Promise<void>;
  /** The current checkpoint (or null) plus journaled events with `seq >=` the checkpoint
   *  version — stale pre-checkpoint events are filtered, making writeCheckpoint+clear
   *  crash-safe. */
  loadDelta(): Promise<DeltaBundle>;
}

/** The next-seq a checkpoint covers (absolute): baseSeq + embedded event count. */
function checkpointVersion(c: StoredArtifact | null): number {
  return c ? (c.baseSeq ?? 0) + c.events.length : 0;
}

/** In-memory DeltaStoragePort (deep-clones on the boundary). */
export class MemoryDeltaStorage implements DeltaStoragePort {
  private checkpoint: StoredArtifact | null = null;
  private journal: MutationEvent[] = [];

  async writeCheckpoint(artifact: StoredArtifact): Promise<void> {
    this.checkpoint = structuredClone(artifact);
    this.journal = [];
  }

  async appendEvents(events: readonly MutationEvent[]): Promise<void> {
    for (const e of events) this.journal.push(structuredClone(e));
  }

  async loadDelta(): Promise<DeltaBundle> {
    const v = checkpointVersion(this.checkpoint);
    return {
      checkpoint: this.checkpoint ? structuredClone(this.checkpoint) : null,
      journal: this.journal.filter((e) => e.seq >= v).map((e) => structuredClone(e)),
    };
  }
}

/**
 * File-backed DeltaStoragePort: the checkpoint is a JSON file (atomic + validated, via
 * `FileStorage`); the journal is an append-only NDJSON file (one event per line).
 * `writeCheckpoint` clears the journal; a torn final journal line (crash mid-append) is
 * treated as a truncated tail and ignored.
 */
export class FileDeltaStorage implements DeltaStoragePort {
  private readonly checkpointStore: FileStorage;

  constructor(
    checkpointPath: string,
    private readonly journalPath: string,
  ) {
    this.checkpointStore = new FileStorage(checkpointPath);
  }

  async writeCheckpoint(artifact: StoredArtifact): Promise<void> {
    await this.checkpointStore.save(artifact);
    await writeFile(this.journalPath, "", "utf8");
  }

  async appendEvents(events: readonly MutationEvent[]): Promise<void> {
    if (events.length === 0) return;
    const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await appendFile(this.journalPath, lines, "utf8");
  }

  async loadDelta(): Promise<DeltaBundle> {
    const checkpoint = await this.checkpointStore.load();
    const v = checkpointVersion(checkpoint);
    let text = "";
    try {
      text = await readFile(this.journalPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const journal: MutationEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        journal.push(JSON.parse(line) as MutationEvent);
      } catch {
        break; // torn tail from a crash mid-append — stop here
      }
    }
    return { checkpoint, journal: journal.filter((e) => e.seq >= v) };
  }
}
```

- [ ] **Step 4: Barrel-export the module.** In `src/index.ts`, add after the `export * from "./delta";` line:

```ts
export * from "./delta-storage";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/m13-delta-storage.test.ts`
Expected: PASS (10 tests — 5 cases × 2 implementations). Then `npx vitest run` — no regressions.

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck` (clean), then:

```bash
git add src/delta-storage.ts src/index.ts test/m13-delta-storage.test.ts
git commit -m "feat: DeltaStoragePort + Memory/File impls (checkpoint + appendable NDJSON journal)"
```

---

### Task 3: Delta persist + restore orchestration

**Files:**
- Modify: `src/delta.ts`
- Test: `test/m13-persist-restore.test.ts`

- [ ] **Step 1: Write the failing test `test/m13-persist-restore.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { Replay } from "../src/replay";
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

describe("M13 delta persist + restore", () => {
  it("restoreFromDelta returns null when no checkpoint exists", async () => {
    const store = new MemoryDeltaStorage();
    expect(await restoreFromDelta(store, freshDeps(), new MemoryVectorIndex())).toBeNull();
  });

  it("checkpoint + appended deltas restore the current tree, types, and log", async () => {
    const a = setup();
    a.mutator.insert({ path: "/docs" }, "keep", "K");
    a.mutator.insert({ path: "/docs" }, "gone", "G");
    a.mutator.insert({ path: "/docs" }, "edit", { body: "E" }, { type: "doc" });
    const idKeep = a.addressing.byPath("/docs/keep")!.id;
    const idGone = a.addressing.byPath("/docs/gone")!.id;

    const vectors = new MemoryVectorIndex();
    vectors.upsert([
      { nodeId: idKeep, vector: [1, 0] },
      { nodeId: idGone, vector: [0, 1] },
    ]);

    const store = new MemoryDeltaStorage();
    let hw = await persistCheckpoint(store, a.tree, a.log, vectors);

    a.mutator.remove({ path: "/docs/gone" });
    a.mutator.set({ path: "/docs/edit" }, { body: "E2" }, { type: "doc" });
    hw = await persistDelta(store, a.log, hw);
    expect(hw).toBe(a.log.length());

    const v2 = new MemoryVectorIndex();
    const r = (await restoreFromDelta(store, freshDeps(), v2))!;
    expect(r).not.toBeNull();
    expect(r.tree.toJson()).toEqual(a.tree.toJson());
    expect(r.log.length()).toBe(a.log.length());

    const raddr = new Addressing(r.tree);
    expect(raddr.byPath("/docs/edit")!.type).toBe("doc"); // type preserved through restore
    expect(v2.has(idKeep)).toBe(true); // unchanged node keeps its checkpoint vector
    expect(v2.has(idGone)).toBe(false); // removed node's vector dropped
    expect(raddr.byPath("/docs/edit")!.meta.embedding.state).toBe("stale"); // touched → reindex

    // the restored log is intact: value-level time-travel still works
    expect(new Replay(r.tree, r.log).getAt("/docs/keep", r.log.length())).toBe("K");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/m13-persist-restore.test.ts`
Expected: FAIL — `persistCheckpoint`/`persistDelta`/`restoreFromDelta` are not exported from `../src/delta`.

- [ ] **Step 3: Extend `src/delta.ts`.** Replace the import line `import { Mutator } from "./mutator";` with the expanded import block, and append the three functions at the end of the file:

Replace the top import:

```ts
import type { Json } from "./types";
import { ArtifactTree, type TreeDeps } from "./artifact-tree";
import { Addressing } from "./addressing";
import { EventLog, type MutationEvent } from "./event-log";
import { Mutator } from "./mutator";
import type { VectorIndexPort } from "./vector-index-port";
import { serializeArtifact, restoreArtifact } from "./storage";
import type { DeltaStoragePort } from "./delta-storage";
```

(Delete the now-duplicate `import type { MutationEvent } from "./event-log";` line — `MutationEvent` is imported in the block above. The `Json` import is for the functions below.)

Append at the end of the file:

```ts
/**
 * Append every event newer than `sinceSeq` to the journal (the cheap, common save).
 * Returns the new high-water seq to pass next time. No-op if nothing is new.
 */
export async function persistDelta(store: DeltaStoragePort, log: EventLog, sinceSeq: number): Promise<number> {
  const fresh = log.since(sinceSeq);
  if (fresh.length > 0) await store.appendEvents(fresh);
  return log.length();
}

/**
 * Write a full checkpoint (replacing the prior one and clearing the journal) and return
 * its high-water seq. Pair with M12 `log.compactTo(...)` BEFORE calling to keep the
 * checkpoint's embedded event window small.
 */
export async function persistCheckpoint(
  store: DeltaStoragePort,
  tree: ArtifactTree,
  log: EventLog,
  vectors: VectorIndexPort,
): Promise<number> {
  await store.writeCheckpoint(serializeArtifact(tree, log, vectors));
  return log.length();
}

/**
 * Restore a tree + log from a checkpoint plus its journaled deltas. Returns null if no
 * checkpoint has been written yet. Forward-replays the journal through a `Mutator` so node
 * TYPES are preserved (via each event's `nodeType`) and UNCHANGED nodes keep their ids and
 * checkpoint vectors; touched nodes are re-decomposed and marked `embedding.state: "stale"`
 * for the consumer's `SemanticIndex` reindex, and removed/orphaned nodes' vectors are
 * dropped. `vectors` should be a fresh index (the checkpoint's vectors are upserted into it).
 * Restore must use the same `decompose` decision as the original run (journal-touched nodes
 * are re-decomposed); replay does not re-validate.
 */
export async function restoreFromDelta(
  store: DeltaStoragePort,
  deps: TreeDeps,
  vectors: VectorIndexPort,
): Promise<{ tree: ArtifactTree; log: EventLog } | null> {
  const { checkpoint, journal } = await store.loadDelta();
  if (!checkpoint) return null;
  const { tree } = restoreArtifact(checkpoint, deps, vectors);
  const addressing = new Addressing(tree);
  const replayLog = new EventLog(); // throwaway — the faithful log is rebuilt below
  const mutator = new Mutator(tree, addressing, replayLog, {
    clock: deps.clock,
    onChange: (node) => {
      node.meta.embedding = { state: "stale" };
    },
    onRemove: (id) => {
      vectors.remove(id);
    },
  });
  replayForward(mutator, journal);
  const log = EventLog.fromStored([...checkpoint.events, ...journal], checkpoint.baseSeq ?? 0);
  return { tree, log };
}
```

Note: `Json` is imported for type-completeness/consistency with sibling modules; if the linter flags it as unused, remove the `import type { Json } from "./types";` line. (Everything else in the block is used: `ArtifactTree`/`TreeDeps`/`Addressing`/`EventLog`/`MutationEvent`/`Mutator`/`VectorIndexPort`/`serializeArtifact`/`restoreArtifact`/`DeltaStoragePort`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/m13-persist-restore.test.ts`
Expected: PASS (2 tests). Then `npx vitest run` — no regressions.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (clean), then:

```bash
git add src/delta.ts test/m13-persist-restore.test.ts
git commit -m "feat: persistDelta/persistCheckpoint/restoreFromDelta (checkpoint + forward-replay restore)"
```

---

### Task 4: Capstone + README

**Files:**
- Test: `test/m13-capstone.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write `test/m13-capstone.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { Replay } from "../src/replay";
import { InvalidOpError } from "../src/errors";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { MemoryDeltaStorage } from "../src/delta-storage";
import { persistCheckpoint, persistDelta, restoreFromDelta } from "../src/delta";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function freshDeps(): TreeDeps {
  return { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
}

describe("M13 capstone: bounded-write delta persistence, composed with M12 compaction", () => {
  it("appends only deltas, restores the current tree, then compacts+checkpoints to bound the window", async () => {
    const deps = freshDeps();
    const tree = ArtifactTree.fromJson({ page: "" }, deps);
    const addressing = new Addressing(tree);
    const log = new EventLog();
    const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0) });

    const store = new MemoryDeltaStorage();
    let hw = await persistCheckpoint(store, tree, log, new MemoryVectorIndex()); // empty checkpoint @ v0

    // 30 edits — saved as appended deltas, NOT 30 whole-artifact rewrites
    for (let i = 1; i <= 30; i++) mutator.set({ path: "/page" }, `v${i}`);
    hw = await persistDelta(store, log, hw);

    const bundle = await store.loadDelta();
    expect(bundle.checkpoint!.events.length).toBe(0); // checkpoint was empty
    expect(bundle.journal.length).toBe(30); // only the deltas were written

    const r1 = (await restoreFromDelta(store, freshDeps(), new MemoryVectorIndex()))!;
    expect(r1.tree.toJson()).toEqual({ page: "v30" });
    expect(r1.log.length()).toBe(30);

    // M12 compose: compact to a sliding window, THEN checkpoint → small checkpoint payload
    log.compactTo(log.length() - 5); // keep last 5 events
    await persistCheckpoint(store, tree, log, new MemoryVectorIndex());
    const b2 = await store.loadDelta();
    expect(b2.checkpoint!.events.length).toBe(5); // checkpoint window bounded by compaction
    expect(b2.journal.length).toBe(0); // journal cleared by the checkpoint

    const r2 = (await restoreFromDelta(store, freshDeps(), new MemoryVectorIndex()))!;
    expect(r2.tree.toJson()).toEqual({ page: "v30" });
    const replay = new Replay(r2.tree, r2.log);
    expect(replay.getAt("/page", 30)).toBe("v30"); // current
    expect(replay.getAt("/page", 26)).toBe("v26"); // within the retained window
    expect(() => replay.getAt("/page", 10)).toThrow(InvalidOpError); // below the compaction floor
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/m13-capstone.test.ts`
Expected: PASS — every piece was built in Tasks 1–3. (If it fails, fix the owning task's source, not the test.)

- [ ] **Step 3: Add a "Delta persistence" bullet to `README.md`.** In the "Scope & limits" section, immediately AFTER the "Log growth is bounded by opt-in compaction" bullet (added in M12), insert:

```markdown
- **Saves can be incremental (opt-in delta persistence).** `DeltaStoragePort` (memory + file)
  splits persistence into a periodic full `writeCheckpoint` and cheap `appendEvents` — a
  routine save costs O(new events) instead of rewriting the whole artifact. `persistDelta`
  appends; `persistCheckpoint` snapshots (pair with `compactTo` first to keep the window
  small); `restoreFromDelta` loads the checkpoint and forward-replays the journal, preserving
  node types and the vectors of unchanged nodes (touched nodes are re-decomposed and left
  stale for reindex). A checkpoint still serializes the whole **tree** — delta-of-tree is
  future work; restore must use the same decompose decision as the original run.
```

- [ ] **Step 4: Update the README "Status" line** — append `, delta persistence (M13)` after `log compaction (M12)`.

- [ ] **Step 5: Full suite + typecheck + commit**

Run: `npm test && npm run typecheck` (all green), then:

```bash
git add test/m13-capstone.test.ts README.md
git commit -m "docs+test: M13 delta-persistence capstone (bounded writes, composed with compaction) + README"
```

---

## Milestone 13 — Definition of Done

- [ ] `npm test` — all green (262 prior + ~16 new) and `npm run typecheck` clean; `npm run build` (tsup) still produces `dist/` with the two new modules.
- [ ] `applyEventForward`/`replayForward` reproduce a recorded log's final value AND node types on a fresh tree (set/insert/remove/move), addressed by path.
- [ ] `DeltaStoragePort` (memory + file): `writeCheckpoint` clears the journal; `appendEvents` is append-only; `loadDelta` filters stale pre-checkpoint events; file journal tolerates a torn tail.
- [ ] `persistDelta` appends only new events; `persistCheckpoint` snapshots; `restoreFromDelta` returns the current tree + log, preserves types + unchanged-node vectors, drops removed vectors, marks touched nodes stale, returns null with no checkpoint.
- [ ] Capstone proves: N edits → N journaled events (no whole-artifact rewrite); restore == current; compose with `compactTo` bounds the checkpoint window and the replay floor survives restore.
- [ ] README documents opt-in delta persistence, the forward-replay restore, and the whole-tree-checkpoint / same-decision constraints.

## Roadmap: next

- **DB-backed ports:** `StoragePort`/`DeltaStoragePort` + `VectorIndexPort` over SQLite/sqlite-vec and Postgres/pgvector (the appendable journal maps cleanly to an events table).
- **Checkpoint policy helper:** a thin `Run`-level wrapper (downstream `ArborRun`) that calls `persistDelta` per save and `compactTo`+`persistCheckpoint` every N events / M seconds.
- Then: tag/type indexes for `find`; `stats()` (nodes/events/vectors/staleCount/baseSeq) + `subscribe`; ANN `VectorIndexPort` adapter; publish decision (flip `private` + scoped name + LICENSE).
- Downstream `content-generator-arbor` can adopt `DeltaStoragePort` for long-lived/iterative runs with no core change.

---

## Self-Review

**Spec coverage:** review item #3 (delta persistence — append-only journal + forward-apply restore) → Task 1 (forward apply), Task 2 (appendable port), Task 3 (persist/restore orchestration), Task 4 (capstone proving bounded writes + M12 compose). Forward `applyEvent` (named in the roadmap) = `applyEventForward`. The "periodically re-snapshot" half = `persistCheckpoint` + the documented policy (helper deferred to the consumer, per scope).

**Placeholder scan:** none — every code step carries full code; run steps have exact commands + expected counts; the two conditionals (unused `Json` import; barrel insertion points) name the exact action.

**Type consistency:** `applyEventForward(mutator: Mutator, e: MutationEvent): void` and `replayForward(mutator: Mutator, events: readonly MutationEvent[]): void` are consumed exactly so by `restoreFromDelta` and the tests. `DeltaStoragePort` methods — `writeCheckpoint(StoredArtifact)`, `appendEvents(readonly MutationEvent[])`, `loadDelta(): Promise<DeltaBundle>` — match both impls and `persistDelta`/`persistCheckpoint`/`restoreFromDelta`. `DeltaBundle { checkpoint: StoredArtifact | null; journal: MutationEvent[] }`. `persistDelta(store, log, sinceSeq): Promise<number>`, `persistCheckpoint(store, tree, log, vectors): Promise<number>`, `restoreFromDelta(store, deps, vectors): Promise<{tree,log}|null>`. Event-field reads match `MutationEvent` (`path`, `after`, `nodeType`, `key`, `fromPath`, `toPath`, `to.key`, `seq`, `baseSeq` via `StoredArtifact`). `Mutator` ctor `(tree, addressing, log, {clock,onChange,onRemove})`; `Mutator.set(ref, value, {type})` / `insert(parentRef, key, value, {type})` / `remove(ref)` / `move(ref, toParentRef, key)` — all per mutator.ts. `VectorIndexPort.remove`/`has`/`upsert`/`entries`, `VectorIndexEntry {nodeId, vector}`, `ArbNode.meta.embedding.state` per types.ts. `restoreArtifact`/`serializeArtifact`/`StoredArtifact` per storage.ts (unchanged). `FileStorage` composed by `FileDeltaStorage`. Fixture threshold `sizeBasedDecision(1)` (documented small-container gotcha). Capstone math: empty checkpoint @ v0; 30 sets → journal 30, value `v30`; `compactTo(length-5)` → checkpoint window 5, floor 25 → `getAt(26)` reconstructs, `getAt(10)` throws.
