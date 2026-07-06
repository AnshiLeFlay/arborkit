import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";
import { sizeBasedDecision } from "../src/decompose";
import { InvalidOpError } from "../src/errors";

function buildTree(): ArtifactTree {
  const deps: TreeDeps = {
    idGen: new SeqIdGen(),
    clock: new FixedClock(0),
    decision: sizeBasedDecision(5), // small -> fully decomposed
  };
  return ArtifactTree.fromJson({ pages: [{ title: "Home" }] }, deps);
}

describe("Addressing", () => {
  it("returns the empty pointer for the root", () => {
    const tree = buildTree();
    const addr = new Addressing(tree);
    expect(addr.pathOf(tree.rootIdValue())).toBe("");
  });

  it("computes a JSON Pointer path for a nested node", () => {
    const tree = buildTree();
    const addr = new Addressing(tree);
    const node = addr.byPath("/pages/0/title")!;
    expect(node).toBeDefined();
    expect(node.content).toBe("Home");
    expect(addr.pathOf(node.id)).toBe("/pages/0/title");
  });

  it("resolves byId", () => {
    const tree = buildTree();
    const addr = new Addressing(tree);
    const node = addr.byPath("/pages/0/title")!;
    expect(addr.byId(node.id)).toBe(node);
  });

  it("returns undefined for a path that does not exist", () => {
    const tree = buildTree();
    const addr = new Addressing(tree);
    expect(addr.byPath("/pages/9/title")).toBeUndefined();
  });

  it("pathOf throws on a parent-chain cycle instead of hanging", () => {
    const tree = buildTree();
    const addr = new Addressing(tree);
    const pages = addr.byPath("/pages")!;
    const item = addr.byPath("/pages/0")!;
    // white-box corruption: make the two nodes each other's parent
    (pages as any).parentId = item.id;
    (item as any).parentId = pages.id;
    expect(() => addr.pathOf(item.id)).toThrow(InvalidOpError);
    expect(() => addr.pathOf(item.id)).toThrow(/parent chain cycle/);
    expect(() => addr.pathOf(item.id)).toThrow(new RegExp(item.id));
  });

  it("round-trips path<->id for every node in the tree", () => {
    const tree = buildTree();
    const addr = new Addressing(tree);
    const visit = (id: string) => {
      expect(addr.byPath(addr.pathOf(id))!.id).toBe(id);
      for (const child of tree.children(id)) visit(child.id);
    };
    visit(tree.rootIdValue());
  });
});
