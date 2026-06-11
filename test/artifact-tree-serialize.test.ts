import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function deps(): TreeDeps {
  return { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
}
function make(json: unknown): ArtifactTree {
  return ArtifactTree.fromJson(json as never, deps());
}

describe("ArtifactTree.allNodes + fromStored", () => {
  it("allNodes returns every node and fromStored rebuilds an equivalent tree", () => {
    const tree = make({ a: { b: 1 }, c: 2 });
    const nodes = tree.allNodes();
    expect(nodes.length).toBe(tree.size());
    const rebuilt = ArtifactTree.fromStored(nodes, tree.rootIdValue(), deps());
    expect(rebuilt.toJson()).toEqual(tree.toJson());
    expect(rebuilt.rootIdValue()).toBe(tree.rootIdValue());
  });

  it("fromStored preserves node ids (a stored id resolves in the rebuilt tree)", () => {
    const tree = make({ a: "x" });
    const aId = tree.children(tree.rootIdValue())[0].id;
    const rebuilt = ArtifactTree.fromStored(tree.allNodes(), tree.rootIdValue(), deps());
    expect(rebuilt.get(aId)!.content).toBe("x");
  });
});

describe("ArtifactTree.descendantIds", () => {
  it("lists all transitive descendants, not the node itself", () => {
    const tree = make({ a: { b: { c: 1 } } });
    const aId = tree.children(tree.rootIdValue())[0].id;
    const ids = tree.descendantIds(aId);
    expect(ids).not.toContain(aId);
    expect(ids.length).toBe(2);
    expect(ids.every((id) => tree.get(id) !== undefined)).toBe(true);
  });

  it("returns empty for a leaf", () => {
    const tree = make({ a: "x" });
    const aId = tree.children(tree.rootIdValue())[0].id;
    expect(tree.descendantIds(aId)).toEqual([]);
  });
});
