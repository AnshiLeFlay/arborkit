import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { Replay } from "../src/replay";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function setup(json: unknown) {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson(json as never, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock });
  return { tree, addressing, log, mutator };
}

describe("Replay.reconstructValueAt + getAt", () => {
  it("reconstructs the value at each version of a set chain, incl. the initial state", () => {
    const { tree, log, mutator } = setup({ docs: {} });
    mutator.insert({ path: "/docs" }, "a", "v1");
    mutator.set({ path: "/docs/a" }, "v2");
    mutator.set({ path: "/docs/a" }, "v3");
    const replay = new Replay(tree, log);
    expect(replay.reconstructValueAt(0)).toEqual({ docs: {} });
    expect(replay.getAt("/docs/a", 1)).toBe("v1");
    expect(replay.getAt("/docs/a", 2)).toBe("v2");
    expect(replay.getAt("/docs/a", 3)).toBe("v3");
    expect(replay.getAt("/docs/a", 0)).toBeUndefined();
  });

  it("clamps version above current and at/below zero", () => {
    const { tree, log, mutator } = setup({ a: "x" });
    mutator.set({ path: "/a" }, "y");
    const replay = new Replay(tree, log);
    expect(replay.getAt("/a", 99)).toBe("y");
    expect(replay.getAt("/a", 0)).toBe("x");
  });
});

describe("Replay.diff", () => {
  it("returns the operations between two versions", () => {
    const { tree, log, mutator } = setup({ docs: {} });
    mutator.insert({ path: "/docs" }, "a", "x");
    mutator.set({ path: "/docs/a" }, "y");
    const replay = new Replay(tree, log);
    const d = replay.diff(1, 2);
    expect(d.length).toBe(1);
    expect(d[0].kind).toBe("set");
  });
});

describe("Replay.revert", () => {
  it("restores a node to a past value as a new appended mutation", () => {
    const { tree, addressing, log, mutator } = setup({ docs: {} });
    mutator.insert({ path: "/docs" }, "a", "original");
    mutator.set({ path: "/docs/a" }, "changed");
    const replay = new Replay(tree, log);
    replay.revert(mutator, addressing, { path: "/docs/a" }, 1);
    expect(tree.toJson()).toEqual({ docs: { a: "original" } });
    expect(log.length()).toBe(3);
  });
});
