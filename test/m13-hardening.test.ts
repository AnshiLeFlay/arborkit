import { describe, it, expect, afterEach } from "vitest";
import { rm, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog, type MutationEvent } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { InvalidOpError } from "../src/errors";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { MemoryDeltaStorage, FileDeltaStorage } from "../src/delta-storage";
import { persistCheckpoint, persistDelta, restoreFromDelta } from "../src/delta";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

const dir = mkdtempSync(join(tmpdir(), "arbor-m13h-"));
const cpPath = join(dir, "cp.json");
const jPath = join(dir, "journal.ndjson");

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
function ev(seq: number): MutationEvent {
  return { seq, kind: "set", targetId: "n1", parentId: "n0", key: "k", path: "/docs", after: { v: seq }, ts: 0 };
}

describe("M13 hardening", () => {
  afterEach(async () => {
    await rm(cpPath, { force: true });
    await rm(jPath, { force: true });
  });

  it("file journal: events appended AFTER a torn tail are not lost on load", async () => {
    const a = setup();
    const store = new FileDeltaStorage(cpPath, jPath);
    await persistCheckpoint(store, a.tree, a.log, new MemoryVectorIndex()); // v0
    await store.appendEvents([ev(0)]);
    // simulate a crash mid-append: torn partial line, no trailing newline
    await appendFile(jPath, '{"seq":1,"kind":"se', "utf8");
    // a restarted process appends more events — they must land on clean lines
    await store.appendEvents([ev(1), ev(2)]);
    const { journal } = await store.loadDelta();
    expect(journal.map((e) => e.seq)).toEqual([0, 1, 2]); // torn fragment skipped, later events kept
  });

  it("persistDelta throws if compaction already dropped not-yet-journaled events", async () => {
    const a = setup();
    a.mutator.insert({ path: "/docs" }, "a", "1"); // seq 0
    a.mutator.set({ path: "/docs/a" }, "2"); // seq 1
    a.mutator.set({ path: "/docs/a" }, "3"); // seq 2
    a.log.compactTo(2); // events 0,1 gone — but sinceSeq=0 was never journaled
    const store = new MemoryDeltaStorage();
    await expect(persistDelta(store, a.log, 0)).rejects.toThrow(InvalidOpError);
  });

  it("restoreFromDelta throws on a non-contiguous journal instead of replaying silently wrong state", async () => {
    const a = setup();
    const store = new MemoryDeltaStorage();
    await persistCheckpoint(store, a.tree, a.log, new MemoryVectorIndex()); // v0
    await store.appendEvents([ev(0), ev(2)]); // gap: seq 1 missing
    await expect(restoreFromDelta(store, freshDeps(), new MemoryVectorIndex())).rejects.toThrow(InvalidOpError);
  });
});
