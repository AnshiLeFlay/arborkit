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
