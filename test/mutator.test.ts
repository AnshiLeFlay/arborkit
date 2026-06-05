import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { NodeNotFoundError } from "../src/errors";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";
import { sizeBasedDecision } from "../src/decompose";

function setup(json: unknown) {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(5) };
  const tree = ArtifactTree.fromJson(json as never, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock });
  return { tree, addressing, log, mutator, clock };
}

describe("Mutator.set", () => {
  it("replaces a value, bumps the node version, and logs before/after", () => {
    const { tree, addressing, log, mutator, clock } = setup({ title: "Old" });
    clock.advance(10);
    mutator.set({ path: "/title" }, "New");
    expect(tree.toJson()).toEqual({ title: "New" });
    const node = addressing.byPath("/title")!;
    expect(node.meta.version).toBe(1);
    expect(node.meta.updatedAt).toBe(10);
    const e = log.entries()[0];
    expect(e).toMatchObject({ kind: "set", before: "Old", after: "New", targetId: node.id });
  });

  it("resolves a Ref by id as well as by path", () => {
    const { tree, addressing, mutator } = setup({ title: "Old" });
    const id = addressing.byPath("/title")!.id;
    mutator.set({ id }, "ById");
    expect(tree.toJson()).toEqual({ title: "ById" });
  });

  it("throws NodeNotFoundError for a missing ref", () => {
    const { mutator } = setup({ title: "Old" });
    expect(() => mutator.set({ path: "/nope" }, 1)).toThrow(NodeNotFoundError);
  });
});

describe("Mutator.insert", () => {
  it("inserts an object key, bumps the PARENT version, and logs the insert", () => {
    const { tree, addressing, log, mutator } = setup({ a: 1 });
    const newId = mutator.insert({ path: "" }, "b", 2);
    expect(tree.toJson()).toEqual({ a: 1, b: 2 });
    expect(addressing.byPath("")!.meta.version).toBe(1); // root (parent) bumped
    expect(tree.get(newId)!.meta.version).toBe(0); // new node starts at 0
    expect(log.entries()[0]).toMatchObject({ kind: "insert", targetId: newId, after: 2 });
  });
});

describe("Mutator.remove", () => {
  it("removes a node, bumps the parent version, and logs before", () => {
    const { tree, addressing, log, mutator } = setup({ a: 1, b: 2 });
    mutator.remove({ path: "/b" });
    expect(tree.toJson()).toEqual({ a: 1 });
    expect(addressing.byPath("")!.meta.version).toBe(1);
    expect(log.entries()[0]).toMatchObject({ kind: "remove", before: 2 });
  });

  it("refuses to remove the root", () => {
    const { mutator } = setup({ a: 1 });
    expect(() => mutator.remove({ path: "" })).toThrow();
  });
});
