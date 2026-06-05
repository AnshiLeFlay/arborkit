import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";
import { sizeBasedDecision } from "../src/decompose";

function deps(maxOpaqueBytes: number): TreeDeps {
  return { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(maxOpaqueBytes) };
}

const DATA = { pages: [{ title: "Home" }, { title: "About" }], brand: { price: "10" } };

describe("ArtifactTree.fromJson + toJson", () => {
  it("round-trips a nested value when the whole tree is opaque", () => {
    const tree = ArtifactTree.fromJson(DATA, deps(1_000_000));
    expect(tree.toJson()).toEqual(DATA);
    expect(tree.size()).toBe(1); // entire JSON kept as one opaque leaf
    expect(tree.root().kind).toBe("leaf");
  });

  it("round-trips a nested value when decomposed", () => {
    const tree = ArtifactTree.fromJson(DATA, deps(5));
    expect(tree.toJson()).toEqual(DATA);
    expect(tree.size()).toBeGreaterThan(1); // it split
    expect(tree.root().kind).toBe("object");
  });

  it("exposes ordered children with their keys", () => {
    const tree = ArtifactTree.fromJson(DATA, deps(5));
    const rootChildren = tree.children(tree.rootIdValue());
    expect(rootChildren.map((c) => c.key)).toEqual(["pages", "brand"]);
  });

  it("preserves array element order via numeric keys", () => {
    const tree = ArtifactTree.fromJson(DATA, deps(5));
    const pages = tree.children(tree.rootIdValue()).find((c) => c.key === "pages")!;
    expect(tree.children(pages.id).map((c) => c.key)).toEqual([0, 1]);
  });

  it("stamps parentId, version 0 and clock time on built nodes", () => {
    const tree = ArtifactTree.fromJson(DATA, deps(5));
    const root = tree.root();
    expect(root.parentId).toBeNull();
    expect(root.meta.version).toBe(0);
    expect(root.meta.updatedAt).toBe(0);
    const child = tree.children(root.id)[0];
    expect(child.parentId).toBe(root.id);
  });
});
