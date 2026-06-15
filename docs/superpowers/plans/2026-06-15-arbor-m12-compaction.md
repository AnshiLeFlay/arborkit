# Arbor — M12: Event-Log Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap the unbounded event log — add `EventLog.compactTo(floorSeq)` that drops history before a floor (and shrinks both in-memory and serialized size), make `Replay` honor the compaction floor, and persist/restore the floor so it survives a round-trip.

**Architecture:** The materialized tree is always "now"; the log only exists to reverse-apply for time-travel *before* now. Compaction drops events older than a chosen floor and remembers a `baseSeq` (count of dropped events). Crucially, event `seq` stays **absolute** (callers' versions don't shift) — the `events` array becomes a window `[baseSeq, length)`, and a new `at(seq)` accessor maps absolute seq → window index. `length()` keeps returning the absolute next-seq, so `versionNow()`/transaction rollback are unchanged. `Replay` reads via `at(seq)` and throws a clear error for versions below the floor (history genuinely gone, not silently wrong). The persisted `StoredArtifact` gains `baseSeq` (format bumped to `version: 2`, restore tolerant of `1`). Compaction is **opt-in** — nothing auto-compacts, so all existing behavior (full history, `getAt(path, 0)`) is preserved until a consumer calls `compactTo`.

**Tech Stack:** Node ≥20.6, TypeScript (ESM, strict), Vitest. No new dependencies. Builds on M1–M11 (247 tests).

---

## Scope of THIS plan (Milestone 12)

Review item #2 ("log compaction / checkpointing — caps the unbounded-log memory problem and the per-persist serialize size"). Produces: a compaction primitive + floor-aware replay + floor-preserving persistence, all opt-in and back-compatible.

**Out of scope (next milestone M13):** delta persistence (append-only event journal + forward-apply restore instead of whole-artifact rewrite) — the review's item #3; it needs a forward `applyEvent` + an appendable storage port and is a separate, larger change. Also out: a `Run`/checkpoint-policy wrapper (Arbor core has no run abstraction — that lives in the downstream's `ArborRun`; M12 ships the `compactTo` primitive + a documented usage pattern, and the downstream can call it).

## Design decisions (locked for M12)

1. **`seq` stays absolute; the array is a window.** `EventLog` gains `private baseSeq` (default 0 = no compaction). `append` stamps `seq = baseSeq + events.length`; `length()` returns `baseSeq + events.length` (absolute — unchanged semantics); `entries()` returns the window; `at(seq)` maps absolute→window (undefined below floor / past end). `since(seq)`/`truncateTo(length)` become baseSeq-aware. `fromStored(events, baseSeq=0)` restores the floor.
2. **`compactTo(floorSeq)` is opt-in and clamped** to `[baseSeq, length()]`; returns the count dropped. `compactTo(length())` drops all history (keeps only current state); `compactTo(length() - N)` keeps the last N events.
3. **Replay errors below the floor, doesn't silently clamp.** `reconstructValueAt(v < baseSeq)` throws `InvalidOpError` (the value is unrecoverable). `getAt`/`revert` inherit it. `diff(vA, vB)` returns the *retained* events in `[vA, vB)` (compacted events are gone — documented). Default (uncompacted, baseSeq=0) behavior is byte-identical to M11.
4. **Persisted format → `version: 2` with `baseSeq?`,** restore tolerant of `version: 1` (absent baseSeq → 0). `FileStorage`'s shape validator accepts `1 | 2`. This demonstrates a concrete migration path (the review's open question) at minimal cost; `baseSeq` is optional on the type so a v1 file is still a valid `StoredArtifact`.
5. **No Mutator change.** `transaction` captures `logLen = log.length()` (absolute) before `fn()` and `truncateTo(logLen)` on rollback; since compaction never runs inside a transaction, `logLen >= baseSeq` always, so the baseSeq-aware `truncateTo` is transparent.

## File structure (Milestone 12)

- Modify: `src/event-log.ts` — `baseSeq`, `compactTo`, `at`, `baseSeqValue`, baseSeq-aware `append`/`length`/`since`/`truncateTo`, `fromStored(events, baseSeq)`.
- Modify: `src/replay.ts` — read via `at(seq)`; floor guard in `reconstructValueAt`; floor-aware `typeAt`; seq-based `diff`.
- Modify: `src/storage.ts` — `StoredArtifact` `version: 1 | 2` + `baseSeq?`; serialize writes 2 + baseSeq; restore reads `baseSeq ?? 0`.
- Modify: `src/file-storage.ts` — validator accepts `version` `1 | 2`.
- Modify: `README.md` — "Growth & compaction" note + Status.
- Test: `test/m12-compaction.test.ts`, `test/m12-replay-floor.test.ts`, `test/m12-storage-baseseq.test.ts`, `test/m12-capstone.test.ts`.

---

### Task 1: EventLog compaction primitive

**Files:**
- Modify: `src/event-log.ts`
- Test: `test/m12-compaction.test.ts`

- [ ] **Step 1: Write the failing test `test/m12-compaction.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { EventLog } from "../src/event-log";

function ev(kind: "set" | "insert" = "set") {
  return { kind, targetId: "n1", parentId: "n0", key: "k", ts: 0 } as const;
}

describe("M12 EventLog compaction", () => {
  it("append stamps absolute seqs; length is absolute", () => {
    const log = new EventLog();
    expect(log.append(ev()).seq).toBe(0);
    expect(log.append(ev()).seq).toBe(1);
    expect(log.length()).toBe(2);
    expect(log.baseSeqValue()).toBe(0);
  });

  it("compactTo drops the front, advances baseSeq, keeps seqs absolute, returns count", () => {
    const log = new EventLog();
    for (let i = 0; i < 5; i++) log.append(ev()); // seqs 0..4
    const dropped = log.compactTo(3); // drop seqs 0,1,2
    expect(dropped).toBe(3);
    expect(log.baseSeqValue()).toBe(3);
    expect(log.length()).toBe(5); // absolute next-seq unchanged
    expect(log.entries().map((e) => e.seq)).toEqual([3, 4]); // window
    expect(log.append(ev()).seq).toBe(5); // new seqs continue absolute
  });

  it("at(seq) maps absolute seq → window; undefined below floor / past end", () => {
    const log = new EventLog();
    for (let i = 0; i < 5; i++) log.append(ev());
    log.compactTo(2);
    expect(log.at(1)).toBeUndefined(); // compacted away
    expect(log.at(2)!.seq).toBe(2);
    expect(log.at(4)!.seq).toBe(4);
    expect(log.at(5)).toBeUndefined(); // past end
  });

  it("since() works across compaction (absolute seq filter)", () => {
    const log = new EventLog();
    for (let i = 0; i < 5; i++) log.append(ev());
    log.compactTo(2);
    expect(log.since(3).map((e) => e.seq)).toEqual([3, 4]);
    expect(log.since(0).map((e) => e.seq)).toEqual([2, 3, 4]); // below floor → only retained
  });

  it("compactTo clamps to [baseSeq, length] and is idempotent at the ceiling", () => {
    const log = new EventLog();
    for (let i = 0; i < 3; i++) log.append(ev());
    expect(log.compactTo(99)).toBe(3); // clamp to length → drop all history
    expect(log.entries()).toEqual([]);
    expect(log.length()).toBe(3);
    expect(log.compactTo(0)).toBe(0); // below baseSeq → no-op
    expect(log.compactTo(3)).toBe(0); // at ceiling → no-op
  });

  it("truncateTo is baseSeq-aware (transaction rollback past a compacted log)", () => {
    const log = new EventLog();
    for (let i = 0; i < 5; i++) log.append(ev());
    log.compactTo(2); // baseSeq 2, window seqs 2,3,4
    log.truncateTo(3); // roll back to absolute length 3 → keep seqs 2 only
    expect(log.entries().map((e) => e.seq)).toEqual([2]);
    expect(log.length()).toBe(3);
  });

  it("fromStored restores the baseSeq floor", () => {
    const log = new EventLog();
    for (let i = 0; i < 4; i++) log.append(ev());
    log.compactTo(2);
    const restored = EventLog.fromStored([...log.entries()], log.baseSeqValue());
    expect(restored.baseSeqValue()).toBe(2);
    expect(restored.length()).toBe(4);
    expect(restored.at(2)!.seq).toBe(2);
    expect(restored.at(1)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/m12-compaction.test.ts`
Expected: FAIL — `compactTo`/`at`/`baseSeqValue` not defined.

- [ ] **Step 3: Rewrite the `EventLog` class in `src/event-log.ts`** (keep the imports + `OpKind` + `MutationEvent` interface above it exactly as-is; replace the class):

```ts
/** Append-only log of mutations with monotonic, absolute seq. Supports compaction:
 *  events before `baseSeq` are dropped, but retained events keep their absolute seq
 *  and `length()` stays the absolute next-seq, so versions never shift. */
export class EventLog {
  private readonly events: MutationEvent[] = [];
  private baseSeq = 0; // count of compacted-away events; events[0].seq === baseSeq

  append(event: Omit<MutationEvent, "seq">): MutationEvent {
    const full: MutationEvent = { ...event, seq: this.baseSeq + this.events.length };
    this.events.push(full);
    return full;
  }

  entries(): readonly MutationEvent[] {
    return this.events;
  }

  /** Absolute seq of the oldest retained event (0 until compaction). Versions below
   *  this have been compacted away and are no longer reconstructable. */
  baseSeqValue(): number {
    return this.baseSeq;
  }

  /** The event at absolute `seq`, or undefined if compacted away / past the end. */
  at(seq: number): MutationEvent | undefined {
    const i = seq - this.baseSeq;
    return i >= 0 && i < this.events.length ? this.events[i] : undefined;
  }

  since(seq: number): MutationEvent[] {
    return this.events.filter((e) => e.seq >= seq);
  }

  /** Absolute next-seq / current version (unchanged across compaction). */
  length(): number {
    return this.baseSeq + this.events.length;
  }

  /** Drop events past absolute `length` — used to roll back a failed transaction. */
  truncateTo(length: number): void {
    this.events.length = Math.max(0, length - this.baseSeq);
  }

  /** Compaction: drop every retained event with seq < `floorSeq` (history before it
   *  becomes unreconstructable). `floorSeq` is clamped to [baseSeq, length()].
   *  Returns the number of events dropped. */
  compactTo(floorSeq: number): number {
    const floor = Math.max(this.baseSeq, Math.min(floorSeq, this.length()));
    const drop = floor - this.baseSeq;
    if (drop > 0) {
      this.events.splice(0, drop);
      this.baseSeq = floor;
    }
    return drop;
  }

  /** Rebuild a log from previously serialized events, preserving their seq + the
   *  compaction floor. */
  static fromStored(events: MutationEvent[], baseSeq = 0): EventLog {
    const log = new EventLog();
    log.baseSeq = baseSeq;
    for (const e of events) log.events.push({ ...e });
    return log;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/m12-compaction.test.ts`
Expected: PASS (7 tests). Then `npx vitest run` — no regressions (default baseSeq=0 keeps every existing behavior; `length()`/`entries()`/`since`/`truncateTo`/`append`/`fromStored(events)` are byte-identical when uncompacted).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (clean), then:

```bash
git add src/event-log.ts test/m12-compaction.test.ts
git commit -m "feat: EventLog.compactTo + baseSeq (absolute seqs, windowed array, at() accessor)"
```

---

### Task 2: Replay honors the compaction floor

**Files:**
- Modify: `src/replay.ts`
- Test: `test/m12-replay-floor.test.ts`

- [ ] **Step 1: Write the failing test `test/m12-replay-floor.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { Replay } from "../src/replay";
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

describe("M12 Replay honors the compaction floor", () => {
  it("reconstructs versions at/above the floor; throws below it", () => {
    const { tree, log, mutator } = setup();
    mutator.insert({ path: "/docs" }, "a", "v1"); // seq 0
    mutator.set({ path: "/docs/a" }, "v2"); // seq 1
    mutator.set({ path: "/docs/a" }, "v3"); // seq 2
    const replay = new Replay(tree, log);

    log.compactTo(2); // drop seqs 0,1; floor = 2
    expect(replay.getAt("/docs/a", 3)).toBe("v3"); // current
    expect(replay.getAt("/docs/a", 2)).toBe("v3"); // at floor: state after the retained-from point... reconstructable
    expect(() => replay.getAt("/docs/a", 1)).toThrow(InvalidOpError); // below floor → gone
    expect(() => replay.getAt("/docs/a", 0)).toThrow(InvalidOpError);
  });

  it("uncompacted log behaves exactly as before (version 0 = initial)", () => {
    const { tree, log, mutator } = setup();
    mutator.insert({ path: "/docs" }, "a", "v1");
    const replay = new Replay(tree, log);
    expect(replay.reconstructValueAt(0)).toEqual({ docs: {} });
    expect(replay.getAt("/docs/a", 0)).toBeUndefined();
  });

  it("diff returns retained events in [vA, vB)", () => {
    const { tree, log, mutator } = setup();
    mutator.insert({ path: "/docs" }, "a", "x"); // 0
    mutator.set({ path: "/docs/a" }, "y"); // 1
    mutator.set({ path: "/docs/a" }, "z"); // 2
    const replay = new Replay(tree, log);
    log.compactTo(1);
    expect(replay.diff(0, 3).map((e) => e.seq)).toEqual([1, 2]); // seq 0 compacted out
    expect(replay.diff(2, 3).map((e) => e.seq)).toEqual([2]);
  });

  it("revert to a retained version still works after compaction", () => {
    const { tree, addressing, log, mutator } = setup();
    mutator.insert({ path: "/docs" }, "a", "original"); // 0
    const vKeep = log.length(); // 1
    mutator.set({ path: "/docs/a" }, "changed"); // 1
    const replay = new Replay(tree, log);
    log.compactTo(1); // floor = 1; vKeep is at the floor, still reconstructable
    replay.revert(mutator, addressing, { path: "/docs/a" }, vKeep);
    expect(tree.toJson()).toEqual({ docs: { a: "original" } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/m12-replay-floor.test.ts`
Expected: FAIL — below-floor reconstruction returns a wrong value / no throw (Replay indexes `events[seq]` against the window).

- [ ] **Step 3: Modify `src/replay.ts`.** Change the errors import (line 6) and the three methods that read events.

Imports — replace `import type { Ref } from "./errors";` with:

```ts
import { type Ref, InvalidOpError } from "./errors";
```

Replace `reconstructValueAt`:

```ts
  /** The whole artifact's JSON value as of `version` (0 = initial, log.length = current).
   *  Throws if `version` is below the compaction floor (that history was dropped). */
  reconstructValueAt(version: number): Json {
    const total = this.log.length();
    const floor = this.log.baseSeqValue();
    if (version < floor) {
      throw new InvalidOpError(`cannot reconstruct version ${version}: history before ${floor} was compacted`);
    }
    const target = Math.min(version, total);
    let value: Json = structuredClone(this.tree.toJson());
    for (let seq = total - 1; seq >= target; seq--) {
      value = reverseApplyValue(value, this.log.at(seq)!);
    }
    return value;
  }
```

Replace `diff`:

```ts
  /** The mutations applied between version `vA` (inclusive) and `vB` (exclusive).
   *  Events compacted away are not included. */
  diff(vA: number, vB: number): MutationEvent[] {
    return this.log.since(vA).filter((e) => e.seq < vB);
  }
```

Replace `typeAt` (read via `at`, start no earlier than the floor):

```ts
  private typeAt(path: string, version: number): string | null | undefined {
    const total = this.log.length();
    for (let seq = Math.max(version, this.log.baseSeqValue()); seq < total; seq++) {
      const e = this.log.at(seq)!;
      if (e.path !== path) continue;
      if (e.kind === "set" || e.kind === "remove") {
        return e.nodeTypeBefore === undefined ? undefined : e.nodeTypeBefore;
      }
      if (e.kind === "insert") return null;
    }
    return undefined;
  }
```

(`getAt` and `revert` are unchanged — they call `reconstructValueAt`/`typeAt`, which now enforce the floor.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/m12-replay-floor.test.ts`
Expected: PASS (4 tests). Then `npx vitest run` — no regressions (M7 replay tests use uncompacted logs: floor 0, `at(seq)` ≡ `entries()[seq]`, version 0 reconstructable).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (clean), then:

```bash
git add src/replay.ts test/m12-replay-floor.test.ts
git commit -m "feat: Replay honors the compaction floor (at()-based reads; InvalidOpError below baseSeq)"
```

---

### Task 3: Persist + restore the compaction floor (StoredArtifact v2)

**Files:**
- Modify: `src/storage.ts`
- Modify: `src/file-storage.ts`
- Test: `test/m12-storage-baseseq.test.ts`

- [ ] **Step 1: Write the failing test `test/m12-storage-baseseq.test.ts`**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { Replay } from "../src/replay";
import { InvalidOpError } from "../src/errors";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { serializeArtifact, restoreArtifact, MemoryStorage, type StoredArtifact } from "../src/storage";
import { FileStorage } from "../src/file-storage";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

const dir = mkdtempSync(join(tmpdir(), "arbor-m12-"));
function freshDeps(): TreeDeps {
  return { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
}

describe("M12 storage preserves the compaction floor", () => {
  afterEach(async () => {
    await rm(join(dir, "a.json"), { force: true });
  });

  it("serialize writes version 2 + baseSeq; restore preserves the floor", async () => {
    const tree = ArtifactTree.fromJson({ docs: {} }, freshDeps());
    const addressing = new Addressing(tree);
    const log = new EventLog();
    const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0) });
    mutator.insert({ path: "/docs" }, "a", "x"); // 0
    mutator.set({ path: "/docs/a" }, "y"); // 1
    log.compactTo(1);

    const dumped = serializeArtifact(tree, log, new MemoryVectorIndex());
    expect(dumped.version).toBe(2);
    expect(dumped.baseSeq).toBe(1);
    expect(dumped.events.map((e) => e.seq)).toEqual([1]); // only the retained window

    const { tree: rtree, log: rlog } = restoreArtifact(dumped, freshDeps(), new MemoryVectorIndex());
    expect(rlog.baseSeqValue()).toBe(1);
    expect(rlog.length()).toBe(2);
    const replay = new Replay(rtree, rlog);
    expect(() => replay.getAt("/docs/a", 0)).toThrow(InvalidOpError); // floor survived the round-trip
    expect(replay.getAt("/docs/a", 2)).toBe("y");
  });

  it("restore tolerates a v1 stored artifact (no baseSeq → floor 0)", () => {
    const v1: StoredArtifact = {
      version: 1,
      rootId: "n0",
      nodes: [{ id: "n0", parentId: null, key: null, kind: "object", content: null, childIds: [], meta: { version: 0, updatedAt: 0, embedding: { state: "none" } } }],
      events: [],
      vectors: [],
    };
    const { log } = restoreArtifact(v1, freshDeps(), new MemoryVectorIndex());
    expect(log.baseSeqValue()).toBe(0);
  });

  it("FileStorage round-trips a compacted (v2) artifact", async () => {
    const tree = ArtifactTree.fromJson({ a: "x" }, freshDeps());
    const log = new EventLog();
    const dumped = serializeArtifact(tree, log, new MemoryVectorIndex());
    const store = new FileStorage(join(dir, "a.json"));
    await store.save(dumped);
    const loaded = await store.load();
    expect(loaded).toEqual(dumped);
    expect(loaded!.version).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/m12-storage-baseseq.test.ts`
Expected: FAIL — `serializeArtifact` writes `version: 1` and no `baseSeq`; `restoreArtifact` ignores baseSeq; (and once serialize writes 2, `FileStorage.load`'s `version === 1` validator would reject it).

- [ ] **Step 3: Modify `src/storage.ts`.** Replace the `StoredArtifact` interface + `serializeArtifact` + `restoreArtifact`:

```ts
/** A JSON-serializable snapshot of an entire artifact: tree + event-log + vectors.
 *  v2 adds `baseSeq` (the event-log compaction floor); v1 files restore with floor 0. */
export interface StoredArtifact {
  version: 1 | 2;
  rootId: NodeId;
  nodes: ArbNode[];
  events: MutationEvent[];
  /** Absolute seq of the oldest retained event (compaction floor). Absent in v1 → 0. */
  baseSeq?: number;
  vectors: VectorIndexEntry[];
}
```

```ts
/** Dump the live components into a StoredArtifact (v2). */
export function serializeArtifact(tree: ArtifactTree, log: EventLog, vectors: VectorIndexPort): StoredArtifact {
  return {
    version: 2,
    rootId: tree.rootIdValue(),
    nodes: tree.allNodes(),
    events: [...log.entries()],
    baseSeq: log.baseSeqValue(),
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
  const log = EventLog.fromStored(stored.events, stored.baseSeq ?? 0);
  vectors.upsert(stored.vectors);
  return { tree, log };
}
```

- [ ] **Step 4: Modify `src/file-storage.ts`** — the validator's version check (line 8) becomes version-tolerant:

```ts
    (a["version"] === 1 || a["version"] === 2) &&
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/m12-storage-baseseq.test.ts`
Expected: PASS (3 tests). Then `npx vitest run` — no regressions (M6/M10 round-trip tests: serialize now emits `version: 2` + `baseSeq: 0`; any test asserting `version === 1` on a *fresh* serialize must be re-checked — if one exists, the value legitimately changed to 2 and that test should be updated to `=== 2`; report if so).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck` (clean), then:

```bash
git add src/storage.ts src/file-storage.ts test/m12-storage-baseseq.test.ts
git commit -m "feat: StoredArtifact v2 persists the compaction floor (baseSeq); restore tolerant of v1"
```

---

### Task 4: Capstone + README

**Files:**
- Test: `test/m12-capstone.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write `test/m12-capstone.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { Replay } from "../src/replay";
import { InvalidOpError } from "../src/errors";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { serializeArtifact, restoreArtifact, MemoryStorage } from "../src/storage";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function freshDeps(): TreeDeps {
  return { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
}

describe("M12 capstone: bounded log via sliding-window compaction, round-tripped", () => {
  it("keep-last-N compaction caps log size, preserves recent time-travel, survives persist", async () => {
    const tree = ArtifactTree.fromJson({ page: "" }, freshDeps());
    const addressing = new Addressing(tree);
    const log = new EventLog();
    const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0) });

    // 50 rewrites of the same node — each `set` stores full before/after in the log
    for (let i = 1; i <= 50; i++) mutator.set({ path: "/page" }, `revision ${i}`);
    expect(log.length()).toBe(50);
    expect(log.entries().length).toBe(50); // unbounded so far

    // sliding-window compaction: keep only the last 5 events
    const dropped = log.compactTo(log.length() - 5);
    expect(dropped).toBe(45);
    expect(log.entries().length).toBe(5); // capped
    expect(log.length()).toBe(50); // version unchanged

    const replay = new Replay(tree, log);
    expect(replay.getAt("/page", 50)).toBe("revision 50"); // current
    expect(replay.getAt("/page", 46)).toBe("revision 46"); // within the window
    expect(() => replay.getAt("/page", 40)).toThrow(InvalidOpError); // compacted away

    // persist (bounded payload) → restore → floor + recent history intact
    const store = new MemoryStorage();
    await store.save(serializeArtifact(tree, log, new MemoryVectorIndex()));
    const loaded = (await store.load())!;
    expect(loaded.events.length).toBe(5); // only the window is serialized
    const { tree: rtree, log: rlog } = restoreArtifact(loaded, freshDeps(), new MemoryVectorIndex());
    expect(rlog.baseSeqValue()).toBe(45);
    const rreplay = new Replay(rtree, rlog);
    expect(rreplay.getAt("/page", 50)).toBe("revision 50");
    expect(() => rreplay.getAt("/page", 40)).toThrow(InvalidOpError);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/m12-capstone.test.ts`
Expected: PASS — every piece was built in Tasks 1–3. (If it fails, fix the owning task's source, not the test.)

- [ ] **Step 3: Add a "Growth & compaction" bullet to `README.md`.** In the "Scope & limits" section (added in M10), replace the existing growth bullet:

```markdown
- **Growth is unbounded in v1.** The event log keeps full `before`/`after` values and
  is never compacted; `persist` serializes the whole artifact. Fine for pipeline
  runs (10²–10⁴ nodes, low-MB artifacts); wrong for long-lived, ever-growing state.
```

with:

```markdown
- **Log growth is bounded by opt-in compaction.** `EventLog.compactTo(floorSeq)` drops
  history before a floor — e.g. `log.compactTo(log.length() - N)` keeps a sliding window
  of the last N events, capping both memory and the serialized event payload (the floor
  is persisted as `baseSeq` and survives restore). Time-travel (`getAt`/`reconstructValueAt`/
  `revert`) below the floor throws — that history is gone. Nothing auto-compacts; choose a
  policy (per run, sliding window, or never). `persist` still serializes the whole **tree**
  every save (delta persistence is future work) — so very large artifacts remain costly.
```

- [ ] **Step 4: Update the README "Status" line** — replace `hardened (M10), packaged (M11)` with `hardened (M10), packaged (M11), log compaction (M12)`.

- [ ] **Step 5: Full suite + typecheck + commit**

Run: `npm test && npm run typecheck` (all green), then:

```bash
git add test/m12-capstone.test.ts README.md
git commit -m "docs+test: M12 compaction capstone (sliding window, bounded persist) + README"
```

---

## Milestone 12 — Definition of Done

- [ ] `npm test` — all green (247 prior + ~15 new) and `npm run typecheck` clean.
- [ ] `EventLog.compactTo(floorSeq)` drops history before the floor; seqs stay absolute; `length()`/transaction rollback unchanged; default (uncompacted) behavior byte-identical to M11.
- [ ] `Replay` reconstructs at/above the floor and throws `InvalidOpError` below it; `diff` returns retained events.
- [ ] `StoredArtifact` v2 persists `baseSeq`; restore preserves the floor and tolerates v1 files.
- [ ] README documents opt-in compaction + the time-travel floor + the remaining whole-tree persist cost.

## Roadmap: next

- **M13 — Delta persistence:** an appendable storage port + a forward `applyEvent`, so `persist` writes only events since the last checkpoint (and periodically re-snapshots the tree) instead of rewriting the whole artifact — the review's item #3, pairs with M12's compaction.
- Later: tag/type indexes for `find`; `stats()` (nodes/events/vectors/staleCount/baseSeq) + `subscribe`; ANN `VectorIndexPort` adapter; publish decision (flip `private` + scoped name + LICENSE).
- Downstream `content-generator-arbor` could call `compactTo` between runs (or keep a window) once it wants bounded long-lived state — no change required by M12.

---

## Self-Review

**Spec coverage:** review item #2 (log compaction/checkpointing — caps memory + per-persist serialize size) → Task 1 (primitive) + Task 2 (replay floor) + Task 3 (persist floor) + Task 4 (capstone proving bounded log + bounded serialized payload); migration-path concern → Task 3 (`version: 2`, restore tolerant of v1). Delta persistence (#3) explicitly deferred to M13 in the Roadmap.

**Placeholder scan:** none — every code step carries full code; run steps have exact commands + expected results; the one conditional (a fresh-serialize test asserting `version===1`) names the exact fix (update to `=== 2`) and requires reporting.

**Type consistency:** `EventLog` new/changed members — `compactTo(floorSeq:number):number`, `at(seq:number):MutationEvent|undefined`, `baseSeqValue():number`, `fromStored(events, baseSeq=0)` — are consumed exactly so by `Replay` (`at`, `baseSeqValue`, `length`) and `storage` (`baseSeqValue`, `fromStored(events, baseSeq)`). `StoredArtifact.version: 1 | 2` + optional `baseSeq?: number` matches serialize (writes `2` + baseSeq) and restore (`baseSeq ?? 0`) and the FileStorage validator (`=== 1 || === 2`). `Replay` imports `InvalidOpError` as a value (was a type-only `Ref` import) — `errors.ts` exports it (used since M2). Tests import only existing symbols (`InvalidOpError` from `../src/errors`, `serializeArtifact`/`restoreArtifact`/`MemoryStorage`/`StoredArtifact` from `../src/storage`). The v1-restore fixture's node shape matches `ArbNode` (`kind:"object"`, `meta.embedding.state:"none"`). Fixture threshold `sizeBasedDecision(1)` for the `{docs:{}}` scaffolds (documented gotcha). Capstone math: 50 sets → length 50; `compactTo(45)` drops 45, window 5, floor 45; `getAt(46)` reconstructs (≥ floor), `getAt(40)` throws (< floor).
