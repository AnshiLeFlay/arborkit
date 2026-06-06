import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { Navigator } from "../src/navigator";
import { NodeNotFoundError } from "../src/errors";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function makeNav(json: unknown) {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(3) };
  const tree = ArtifactTree.fromJson(json as never, deps);
  const addressing = new Addressing(tree);
  return { tree, addressing, nav: new Navigator(tree, addressing) };
}

describe("Navigator.describe", () => {
  it("lists direct children with summaries and the node's own path", () => {
    const { nav } = makeNav({ a: { b: 1 }, d: [10, 20] });
    const r = nav.describe();
    expect(r.node.path).toBe("");
    expect(r.node.kind).toBe("object");
    expect(r.children.map((c) => c.key)).toEqual(["a", "d"]);
    const a = r.children.find((c) => c.key === "a")!;
    expect(a.kind).toBe("object");
    expect(a.hasChildren).toBe(true);
    expect(a.size).toBe(1);
  });

  it("summarizes a leaf with a preview and zero hasChildren", () => {
    const { nav } = makeNav({ title: "Home" });
    const r = nav.describe();
    const t = r.children.find((c) => c.key === "title")!;
    expect(t.kind).toBe("leaf");
    expect(t.hasChildren).toBe(false);
    expect(t.preview).toContain("Home");
  });

  it("paginates with offset/limit and reports truncated", () => {
    const { nav } = makeNav({ a: 1, b: 2, c: 3 });
    const r = nav.describe({ path: "" }, { limit: 2 });
    expect(r.children.map((c) => c.key)).toEqual(["a", "b"]);
    expect(r.truncated).toEqual({ shown: 2, total: 3, nextOffset: 2 });
    const r2 = nav.describe({ path: "" }, { offset: 2, limit: 2 });
    expect(r2.children.map((c) => c.key)).toEqual(["c"]);
    expect(r2.truncated).toBeUndefined();
  });

  it("throws NodeNotFoundError for a missing ref", () => {
    const { nav } = makeNav({ a: 1 });
    expect(() => nav.describe({ path: "/nope" })).toThrow(NodeNotFoundError);
  });
});

describe("Navigator.get", () => {
  it("returns the full reconstructed content by default", () => {
    const { nav } = makeNav({ a: { b: 1 }, d: [10, 20] });
    const r = nav.get({ path: "" });
    expect(r.content).toEqual({ a: { b: 1 }, d: [10, 20] });
    expect(r.path).toBe("");
    expect(r.truncated).toBeUndefined();
  });

  it("bounds depth: deeper containers become a truncation marker and truncated=true", () => {
    const { nav } = makeNav({ a: { b: { c: 1 } } });
    const r = nav.get({ path: "" }, { maxDepth: 1 });
    expect(r.truncated).toBe(true);
    expect(typeof (r.content as Record<string, unknown>).a).toBe("string");
  });

  it("returns a leaf's content directly", () => {
    const { nav } = makeNav({ title: "Home" });
    const r = nav.get({ path: "/title" });
    expect(r.content).toBe("Home");
  });
});
