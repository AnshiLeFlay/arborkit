import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function setup(json: unknown) {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson(json as never, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const removed: string[] = [];
  const mutator = new Mutator(tree, addressing, log, { clock, onRemove: (id) => removed.push(id) });
  return { tree, addressing, mutator, removed };
}

describe("Mutator orphaned-descendant cleanup", () => {
  it("remove fires onRemove for the node AND all its descendants", () => {
    const { addressing, mutator, removed } = setup({ docs: { a: { x: "1" } } });
    const aId = addressing.byPath("/docs/a")!.id;
    const xId = addressing.byPath("/docs/a/x")!.id;
    removed.length = 0;
    mutator.remove({ id: aId });
    expect(removed).toContain(aId);
    expect(removed).toContain(xId);
  });

  it("set on a container fires onRemove for the replaced (old) descendants", () => {
    const { addressing, mutator, removed } = setup({ docs: { a: { x: "1" } } });
    const aId = addressing.byPath("/docs/a")!.id;
    const xId = addressing.byPath("/docs/a/x")!.id;
    removed.length = 0;
    mutator.set({ id: aId }, { y: "2" });
    expect(removed).toContain(xId);
  });

  it("set on a leaf (no descendants) fires no onRemove", () => {
    const { addressing, mutator, removed } = setup({ a: "x" });
    const aId = addressing.byPath("/a")!.id;
    removed.length = 0;
    mutator.set({ id: aId }, "y");
    expect(removed).toEqual([]);
  });
});
