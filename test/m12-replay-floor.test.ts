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
    expect(replay.getAt("/docs/a", 2)).toBe("v2"); // at floor: state before the oldest retained event (seq 2) is reconstructable
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
