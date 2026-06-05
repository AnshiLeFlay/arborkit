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

describe("ArtifactTree.insertChild", () => {
  it("inserts a new keyed child into an object", () => {
    const tree = makeTree({ a: 1 });
    tree.insertChild(tree.rootIdValue(), "b", 2);
    expect(tree.toJson()).toEqual({ a: 1, b: 2 });
  });

  it("rejects inserting a duplicate object key", () => {
    const tree = makeTree({ a: 1 });
    expect(() => tree.insertChild(tree.rootIdValue(), "a", 9)).toThrow();
  });

  it("inserts into an array at an index and renumbers keys to match positions", () => {
    const tree = makeTree({ arr: ["x", "z"] });
    const arrId = tree.children(tree.rootIdValue())[0].id;
    tree.insertChild(arrId, 1, "y"); // insert at index 1
    expect(tree.toJson()).toEqual({ arr: ["x", "y", "z"] });
    expect(tree.children(arrId).map((c) => c.key)).toEqual([0, 1, 2]);
  });

  it("rejects inserting into a leaf", () => {
    const tree = makeTree({ a: 1 });
    const aId = tree.children(tree.rootIdValue())[0].id;
    expect(() => tree.insertChild(aId, "x", 1)).toThrow();
  });
});

describe("ArtifactTree.removeChild", () => {
  it("removes an object key", () => {
    const tree = makeTree({ a: 1, b: 2 });
    const bId = tree.children(tree.rootIdValue()).find((c) => c.key === "b")!.id;
    tree.removeChild(tree.rootIdValue(), bId);
    expect(tree.toJson()).toEqual({ a: 1 });
  });

  it("removes an array element and renumbers remaining keys", () => {
    const tree = makeTree({ arr: ["x", "y", "z"] });
    const arrId = tree.children(tree.rootIdValue())[0].id;
    const yId = tree.children(arrId)[1].id;
    tree.removeChild(arrId, yId);
    expect(tree.toJson()).toEqual({ arr: ["x", "z"] });
    expect(tree.children(arrId).map((c) => c.key)).toEqual([0, 1]);
  });
});

describe("ArtifactTree.moveNode", () => {
  it("re-parents a node, preserving its id, and renumbers affected arrays", () => {
    const tree = makeTree({ from: ["a", "b"], to: ["c"] });
    const fromId = tree.children(tree.rootIdValue()).find((c) => c.key === "from")!.id;
    const toId = tree.children(tree.rootIdValue()).find((c) => c.key === "to")!.id;
    const aId = tree.children(fromId)[0].id; // "a"
    tree.moveNode(aId, toId, 1); // append "a" at index 1 of `to`
    expect(tree.get(aId)!.id).toBe(aId); // identity preserved
    expect(tree.toJson()).toEqual({ from: ["b"], to: ["c", "a"] });
    expect(tree.children(fromId).map((c) => c.key)).toEqual([0]);
    expect(tree.children(toId).map((c) => c.key)).toEqual([0, 1]);
  });
});
