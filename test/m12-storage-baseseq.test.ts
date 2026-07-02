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

    const dumped = await serializeArtifact(tree, log, new MemoryVectorIndex());
    expect(dumped.version).toBe(2);
    expect(dumped.baseSeq).toBe(1);
    expect(dumped.events.map((e) => e.seq)).toEqual([1]); // only the retained window

    const { tree: rtree, log: rlog } = await restoreArtifact(dumped, freshDeps(), new MemoryVectorIndex());
    expect(rlog.baseSeqValue()).toBe(1);
    expect(rlog.length()).toBe(2);
    const replay = new Replay(rtree, rlog);
    expect(() => replay.getAt("/docs/a", 0)).toThrow(InvalidOpError); // floor survived the round-trip
    expect(replay.getAt("/docs/a", 2)).toBe("y");
  });

  it("restore tolerates a v1 stored artifact (no baseSeq → floor 0)", async () => {
    const v1: StoredArtifact = {
      version: 1,
      rootId: "n0",
      nodes: [{ id: "n0", parentId: null, key: null, kind: "object", content: null, childIds: [], meta: { version: 0, updatedAt: 0, embedding: { state: "none" } } }],
      events: [],
      vectors: [],
    };
    const { log } = await restoreArtifact(v1, freshDeps(), new MemoryVectorIndex());
    expect(log.baseSeqValue()).toBe(0);
  });

  it("FileStorage round-trips a compacted (v2) artifact", async () => {
    const tree = ArtifactTree.fromJson({ a: "x" }, freshDeps());
    const log = new EventLog();
    const dumped = await serializeArtifact(tree, log, new MemoryVectorIndex());
    const store = new FileStorage(join(dir, "a.json"));
    await store.save(dumped);
    const loaded = await store.load();
    expect(loaded).toEqual(dumped);
    expect(loaded!.version).toBe(2);
  });
});
