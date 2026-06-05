import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";
import { sizeBasedDecision } from "../src/decompose";

function makeTree(json: unknown): ArtifactTree {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(5) };
  return ArtifactTree.fromJson(json as never, deps);
}

describe("ArtifactTree.replaceValue", () => {
  it("replaces a leaf value in place, keeping the same node id", () => {
    const tree = makeTree({ a: "x" });
    const aId = tree.children(tree.rootIdValue())[0].id;
    tree.replaceValue(aId, "y");
    expect(tree.get(aId)!.content).toBe("y");
    expect(tree.toJson()).toEqual({ a: "y" });
  });

  it("changes a leaf into a decomposed object, deleting no longer reachable descendants", () => {
    const tree = makeTree({ a: "x" });
    const aId = tree.children(tree.rootIdValue())[0].id;
    tree.replaceValue(aId, { deep: { nested: "val" } });
    expect(tree.get(aId)!.kind).toBe("object");
    expect(tree.toJson()).toEqual({ a: { deep: { nested: "val" } } });
  });

  it("drops orphaned descendants from the node map when replacing a subtree with a scalar", () => {
    const tree = makeTree({ a: { b: { c: 1 } } });
    const aId = tree.children(tree.rootIdValue())[0].id;
    const sizeBefore = tree.size();
    tree.replaceValue(aId, 0);
    expect(tree.get(aId)!.kind).toBe("leaf");
    expect(tree.get(aId)!.content).toBe(0);
    expect(tree.size()).toBeLessThan(sizeBefore);
    expect(tree.toJson()).toEqual({ a: 0 });
  });
});

describe("ArtifactTree.snapshot / restore", () => {
  it("restores the exact tree state after a snapshot", () => {
    const tree = makeTree({ a: { b: "x" } });
    const snap = tree.snapshot();
    const aId = tree.children(tree.rootIdValue())[0].id;
    tree.replaceValue(aId, "mutated");
    expect(tree.toJson()).toEqual({ a: "mutated" });
    tree.restore(snap);
    expect(tree.toJson()).toEqual({ a: { b: "x" } });
  });

  it("snapshot is independent (later mutations do not leak into it)", () => {
    const tree = makeTree({ n: 1 });
    const snap = tree.snapshot();
    const nId = tree.children(tree.rootIdValue())[0].id;
    tree.replaceValue(nId, 2);
    tree.restore(snap);
    expect(tree.toJson()).toEqual({ n: 1 });
  });
});
