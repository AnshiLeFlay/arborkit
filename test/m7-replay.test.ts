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

describe("M7 replay integration", () => {
  it("reconstructs the value at each version across insert + remove", () => {
    const { tree, log, mutator } = setup({ docs: {} });
    mutator.insert({ path: "/docs" }, "a", "A"); // v1
    mutator.insert({ path: "/docs" }, "b", "B"); // v2
    mutator.remove({ path: "/docs/a" }); // v3
    const replay = new Replay(tree, log);
    expect(replay.reconstructValueAt(3)).toEqual({ docs: { b: "B" } });
    expect(replay.reconstructValueAt(2)).toEqual({ docs: { a: "A", b: "B" } });
    expect(replay.reconstructValueAt(1)).toEqual({ docs: { a: "A" } });
    expect(replay.reconstructValueAt(0)).toEqual({ docs: {} });
  });

  it("reconstructs the value across a move", () => {
    const { tree, log, mutator, addressing } = setup({ from: {}, to: {} });
    mutator.insert({ path: "/from" }, "x", "X"); // v1
    const xId = addressing.byPath("/from/x")!.id;
    mutator.move({ id: xId }, { path: "/to" }, "x"); // v2
    const replay = new Replay(tree, log);
    expect(replay.reconstructValueAt(2)).toEqual({ from: {}, to: { x: "X" } });
    expect(replay.reconstructValueAt(1)).toEqual({ from: { x: "X" }, to: {} });
  });

  it("reconstructs across an array insert + remove (index shifts handled)", () => {
    const { tree, log, mutator } = setup({ list: ["a", "c"] });
    mutator.insert({ path: "/list" }, 1, "b"); // v1: ["a","b","c"]
    mutator.remove({ path: "/list/0" }); // v2: ["b","c"]
    const replay = new Replay(tree, log);
    expect(replay.reconstructValueAt(2)).toEqual({ list: ["b", "c"] });
    expect(replay.reconstructValueAt(1)).toEqual({ list: ["a", "b", "c"] });
    expect(replay.reconstructValueAt(0)).toEqual({ list: ["a", "c"] });
  });

  it("revert undoes a container-level change back to a past value", () => {
    const { tree, addressing, log, mutator } = setup({ page: {} });
    mutator.set({ path: "/page" }, { title: "First", body: "one" }); // v1
    mutator.set({ path: "/page" }, { title: "Second", body: "two" }); // v2
    const replay = new Replay(tree, log);
    replay.revert(mutator, addressing, { path: "/page" }, 1);
    expect(tree.toJson()).toEqual({ page: { title: "First", body: "one" } });
  });
});
