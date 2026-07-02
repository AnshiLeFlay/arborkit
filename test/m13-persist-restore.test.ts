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
    await vectors.upsert([
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
    expect(await v2.has(idKeep)).toBe(true); // unchanged node keeps its checkpoint vector
    expect(await v2.has(idGone)).toBe(false); // removed node's vector dropped
    expect(raddr.byPath("/docs/edit")!.meta.embedding.state).toBe("stale"); // touched → reindex

    // the restored log is intact: value-level time-travel still works
    expect(new Replay(r.tree, r.log).getAt("/docs/keep", r.log.length())).toBe("K");
  });
});
