import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
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

describe("M14 tags in the event log", () => {
  it("insert records the new tags; set records tagsBefore and tags", () => {
    const s = setup();
    s.mutator.insert({ path: "/docs" }, "a", "v1", { tags: ["draft"] });
    s.mutator.set({ path: "/docs/a" }, "v2", { tags: ["final"] });
    s.mutator.set({ path: "/docs/a" }, "v3"); // tags untouched
    expect(s.log.at(0)!.tags).toEqual(["draft"]);
    expect(s.log.at(1)!.tagsBefore).toEqual(["draft"]);
    expect(s.log.at(1)!.tags).toEqual(["final"]);
    expect(s.log.at(2)!.tagsBefore).toEqual(["final"]);
    expect(s.log.at(2)!.tags).toEqual(["final"]); // unchanged carries through
  });

  it("remove records tagsBefore", () => {
    const s = setup();
    s.mutator.insert({ path: "/docs" }, "a", "v1", { tags: ["draft"] });
    s.mutator.remove({ path: "/docs/a" });
    expect(s.log.at(1)!.tagsBefore).toEqual(["draft"]);
  });

  it("delta restore preserves tags on journal-touched nodes (find-by-tag survives)", async () => {
    const s = setup();
    const store = new MemoryDeltaStorage();
    const hw = await persistCheckpoint(store, s.tree, s.log, new MemoryVectorIndex());
    s.mutator.insert({ path: "/docs" }, "a", "v1", { tags: ["draft"] }); // journaled
    await persistDelta(store, s.log, hw);
    const r = (await restoreFromDelta(store, freshDeps(), new MemoryVectorIndex()))!;
    const raddr = new Addressing(r.tree);
    expect(raddr.byPath("/docs/a")!.tags).toEqual(["draft"]); // pre-fix: undefined
  });
});
