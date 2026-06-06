import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { type DecomposeDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

// A decision that honors a type override, else treats only scalars as opaque.
const decision: DecomposeDecision = {
  isOpaque(value, type) {
    if (type === "opaque") return true;
    if (type === "children") return false;
    return value === null || typeof value !== "object";
  },
};

function makeTree(json: unknown): ArtifactTree {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision };
  return ArtifactTree.fromJson(json as never, deps);
}

describe("ArtifactTree type threading", () => {
  it("records node.type on an inserted child", () => {
    const tree = makeTree({});
    const id = tree.insertChild(tree.rootIdValue(), "k", { a: 1 }, "children");
    expect(tree.get(id)!.type).toBe("children");
  });

  it("type 'children' forces a value to decompose", () => {
    const tree = makeTree({});
    const id = tree.insertChild(tree.rootIdValue(), "k", { a: 1 }, "children");
    expect(tree.get(id)!.kind).toBe("object");
  });

  it("type 'opaque' forces a value to stay a leaf", () => {
    const tree = makeTree({});
    const id = tree.insertChild(tree.rootIdValue(), "k", { a: 1, b: 2 }, "opaque");
    expect(tree.get(id)!.kind).toBe("leaf");
    expect(tree.get(id)!.type).toBe("opaque");
  });

  it("replaceValue applies the type and its override in place", () => {
    const tree = makeTree({ x: "v" });
    const xId = tree.children(tree.rootIdValue())[0].id;
    tree.replaceValue(xId, { a: 1, b: 2 }, "opaque");
    expect(tree.get(xId)!.id).toBe(xId);
    expect(tree.get(xId)!.type).toBe("opaque");
    expect(tree.get(xId)!.kind).toBe("leaf");
    expect(tree.toJson()).toEqual({ x: { a: 1, b: 2 } });
  });

  it("untyped children built underneath a typed node are not given a type", () => {
    const tree = makeTree({});
    const id = tree.insertChild(tree.rootIdValue(), "k", { a: 1 }, "children");
    const childA = tree.children(id)[0];
    expect(childA.type).toBeUndefined();
  });
});
