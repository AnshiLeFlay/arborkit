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
  const changed: string[] = [];
  const removed: string[] = [];
  const mutator = new Mutator(tree, addressing, log, {
    clock,
    onChange: (node) => changed.push(node.id),
    onRemove: (id) => removed.push(id),
  });
  return { tree, addressing, mutator, changed, removed };
}

describe("Mutator semantic hooks", () => {
  it("set fires onChange with the mutated node", () => {
    const { addressing, mutator, changed } = setup({ a: "x" });
    const id = addressing.byPath("/a")!.id;
    mutator.set({ path: "/a" }, "y");
    expect(changed).toEqual([id]);
  });

  it("insert fires onChange with the new node", () => {
    const { mutator, tree, changed } = setup({ items: {} });
    const id = mutator.insert({ path: "/items" }, "k", "v");
    expect(changed).toEqual([id]);
    expect(tree.get(id)).toBeDefined();
  });

  it("remove fires onRemove with the removed node id", () => {
    const { addressing, mutator, removed } = setup({ a: "x", b: "y" });
    const id = addressing.byPath("/b")!.id;
    mutator.remove({ path: "/b" });
    expect(removed).toEqual([id]);
  });

  it("move fires NEITHER onChange nor onRemove (content unchanged)", () => {
    const { addressing, mutator, changed, removed } = setup({ from: { x: "v" }, to: {} });
    changed.length = 0;
    removed.length = 0;
    const id = addressing.byPath("/from/x")!.id;
    mutator.move({ id }, { path: "/to" }, "x");
    expect(changed).toEqual([]);
    expect(removed).toEqual([]);
  });
});
