import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { Navigator } from "../src/navigator";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";
import { sizeBasedDecision } from "../src/decompose";

function makeTree(json: unknown): ArtifactTree {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(4) };
  return ArtifactTree.fromJson(json as never, deps);
}

describe("ArtifactTree.childByKey", () => {
  it("finds an object child by key and misses an absent key", () => {
    const tree = makeTree({ alpha: "one", beta: "two" });
    const rootId = tree.rootIdValue();
    const hit = tree.childByKey(rootId, "beta");
    expect(hit).toBeDefined();
    expect(hit!.key).toBe("beta");
    expect(hit!.content).toBe("two");
    expect(tree.childByKey(rootId, "gamma")).toBeUndefined();
  });

  it("finds an array child by numeric-string index and misses out-of-range", () => {
    const tree = makeTree({ items: ["aaa", "bbb", "ccc"] });
    const itemsId = tree.childByKey(tree.rootIdValue(), "items")!.id;
    const hit = tree.childByKey(itemsId, "1");
    expect(hit).toBeDefined();
    expect(hit!.content).toBe("bbb");
    expect(tree.childByKey(itemsId, "3")).toBeUndefined();
    expect(tree.childByKey(itemsId, "-1")).toBeUndefined();
    expect(tree.childByKey(itemsId, "1.5")).toBeUndefined();
    expect(tree.childByKey(itemsId, "x")).toBeUndefined();
  });

  it("rejects non-canonical array index strings (RFC 6901)", () => {
    const tree = makeTree({ items: ["aaa", "bbb", "ccc"] });
    const arrId = tree.childByKey(tree.rootIdValue(), "items")!.id;
    for (const bad of ["01", "", " 1", "1e0", "0x1", "-0", "1.0"]) {
      expect(tree.childByKey(arrId, bad)).toBeUndefined();
    }
    expect(tree.childByKey(arrId, "1")).toBeDefined();
    expect(tree.childByKey(arrId, "0")).toBeDefined();
  });

  it("returns undefined for an unknown parent id", () => {
    const tree = makeTree({ a: 1 });
    expect(tree.childByKey("nope", "a")).toBeUndefined();
  });

  it("sees a newly inserted key after a cached lookup", () => {
    const tree = makeTree({ existing: "val" });
    const rootId = tree.rootIdValue();
    expect(tree.childByKey(rootId, "fresh")).toBeUndefined(); // populate the cache
    tree.insertChild(rootId, "fresh", "new-value");
    const hit = tree.childByKey(rootId, "fresh");
    expect(hit).toBeDefined();
    expect(hit!.content).toBe("new-value");
  });

  it("misses a removed child after a cached lookup", () => {
    const tree = makeTree({ gone: "soon", stays: "here" });
    const rootId = tree.rootIdValue();
    const goneId = tree.childByKey(rootId, "gone")!.id; // populate the cache
    tree.removeChild(rootId, goneId);
    expect(tree.childByKey(rootId, "gone")).toBeUndefined();
    expect(tree.childByKey(rootId, "stays")).toBeDefined();
  });

  it("stays correct on both sides of a move between two object parents", () => {
    const tree = makeTree({ src: { moving: "payload" }, dst: { other: "thing" } });
    const rootId = tree.rootIdValue();
    const srcId = tree.childByKey(rootId, "src")!.id;
    const dstId = tree.childByKey(rootId, "dst")!.id;
    const movingId = tree.childByKey(srcId, "moving")!.id; // populate src cache
    expect(tree.childByKey(dstId, "moved")).toBeUndefined(); // populate dst cache
    tree.moveNode(movingId, dstId, "moved");
    expect(tree.childByKey(srcId, "moving")).toBeUndefined();
    const hit = tree.childByKey(dstId, "moved");
    expect(hit).toBeDefined();
    expect(hit!.id).toBe(movingId);
    expect(hit!.content).toBe("payload");
  });

  it("finds the new children after replaceValue", () => {
    const tree = makeTree({ doc: { old: "content" } });
    const rootId = tree.rootIdValue();
    const docId = tree.childByKey(rootId, "doc")!.id;
    expect(tree.childByKey(docId, "old")).toBeDefined(); // populate the cache
    tree.replaceValue(docId, { brand: "new-stuff", extra: "field" });
    expect(tree.childByKey(docId, "old")).toBeUndefined();
    const hit = tree.childByKey(docId, "brand");
    expect(hit).toBeDefined();
    expect(hit!.content).toBe("new-stuff");
    expect(tree.childByKey(docId, "extra")).toBeDefined();
  });

  it('finds a child keyed literally "a/b" via its raw key string', () => {
    const tree = makeTree({ "a/b": "slashed" });
    const hit = tree.childByKey(tree.rootIdValue(), "a/b");
    expect(hit).toBeDefined();
    expect(hit!.content).toBe("slashed");
  });
});

describe("Navigator.find pointer escaping", () => {
  it('finds a child keyed "a/b" under /x via the escaped pattern /x/a~1b', () => {
    const tree = makeTree({ x: { "a/b": "slashed-value", plain: "other" } });
    const navigator = new Navigator(tree, new Addressing(tree));
    const result = navigator.find({ pathPattern: "/x/a~1b" });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].path).toBe("/x/a~1b");
    expect(result.hits[0].id).toBe(tree.childByKey(tree.childByKey(tree.rootIdValue(), "x")!.id, "a/b")!.id);
  });
});
