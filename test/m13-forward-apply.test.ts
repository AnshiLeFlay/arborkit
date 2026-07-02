import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { replayForward } from "../src/delta";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";
import type { Json } from "../src/types";

function setup(initial: Json) {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson(initial, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0) });
  return { tree, addressing, log, mutator };
}

describe("M13 forward event-apply", () => {
  it("forward-replaying a log onto a fresh copy reproduces the final value", () => {
    const a = setup({ docs: {}, list: [] });
    a.mutator.insert({ path: "/docs" }, "a", "alpha");
    a.mutator.set({ path: "/docs/a" }, "ALPHA");
    a.mutator.insert({ path: "/list" }, 0, "x");
    a.mutator.insert({ path: "/list" }, 1, "y");
    a.mutator.remove({ path: "/list/0" });

    const b = setup({ docs: {}, list: [] });
    replayForward(b.mutator, a.log.entries());
    expect(b.tree.toJson()).toEqual(a.tree.toJson());
    expect(a.tree.toJson()).toEqual({ docs: { a: "ALPHA" }, list: ["y"] });
  });

  it("preserves node types via the event's nodeType", () => {
    const a = setup({ docs: {} });
    a.mutator.insert({ path: "/docs" }, "a", { body: "hi" }, { type: "doc" });
    const b = setup({ docs: {} });
    replayForward(b.mutator, a.log.entries());
    expect(b.addressing.byPath("/docs/a")!.type).toBe("doc");
  });

  it("reproduces a move", () => {
    const a = setup({ a: { x: "1" }, b: {} });
    a.mutator.move({ path: "/a/x" }, { path: "/b" }, "x");
    const b = setup({ a: { x: "1" }, b: {} });
    replayForward(b.mutator, a.log.entries());
    expect(b.tree.toJson()).toEqual({ a: {}, b: { x: "1" } });
  });
});
