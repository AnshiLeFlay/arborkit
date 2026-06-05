import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";
import { sizeBasedDecision } from "../src/decompose";

function setup(json: unknown) {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(4) };
  const tree = ArtifactTree.fromJson(json as never, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock });
  return { tree, addressing, log, mutator };
}

describe("Mutator.move", () => {
  it("moves a node to a new parent, preserves its id, updates its path, and logs from/to", () => {
    const { tree, addressing, log, mutator } = setup({ from: ["a", "b"], to: ["c"] });
    const aId = addressing.byPath("/from/0")!.id;
    mutator.move({ id: aId }, { path: "/to" }, 1);
    expect(tree.toJson()).toEqual({ from: ["b"], to: ["c", "a"] });
    expect(addressing.byId(aId)!.id).toBe(aId); // identity preserved
    expect(addressing.pathOf(aId)).toBe("/to/1"); // path now derived from new location
    const e = log.entries()[0];
    expect(e.kind).toBe("move");
    expect(e.targetId).toBe(aId);
    expect(e.to).toEqual({ parentId: addressing.byPath("/to")!.id, key: 1 });
  });

  it("bumps the moved node and both parents", () => {
    const { tree, addressing, mutator } = setup({ from: ["a"], to: ["c"] });
    const aId = addressing.byPath("/from/0")!.id;
    const fromId = addressing.byPath("/from")!.id;
    const toId = addressing.byPath("/to")!.id;
    mutator.move({ id: aId }, { path: "/to" }, 1);
    expect(tree.get(aId)!.meta.version).toBe(1);
    expect(tree.get(fromId)!.meta.version).toBe(1);
    expect(tree.get(toId)!.meta.version).toBe(1);
  });
});

describe("Mutator.transaction", () => {
  it("applies all ops when the function completes", () => {
    const { tree, mutator } = setup({ a: 1 });
    mutator.transaction(() => {
      mutator.insert({ path: "" }, "b", 2);
      mutator.set({ path: "/a" }, 10);
    });
    expect(tree.toJson()).toEqual({ a: 10, b: 2 });
  });

  it("rolls back the tree and the log when the function throws", () => {
    const { tree, log, mutator } = setup({ a: 1 });
    expect(() =>
      mutator.transaction(() => {
        mutator.insert({ path: "" }, "b", 2);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(tree.toJson()).toEqual({ a: 1 }); // insert rolled back
    expect(log.length()).toBe(0); // log truncated
  });
});
