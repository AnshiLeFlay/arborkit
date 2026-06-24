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
