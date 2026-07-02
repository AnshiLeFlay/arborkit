import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { makeToolset } from "../src/toolset";
import { InvalidOpError } from "../src/errors";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";
import type { Json } from "../src/types";

function setup(initial: Json) {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson(initial, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0) });
  return { tree, addressing, log, mutator };
}

describe("M14 moveNode guards", () => {
  it("rejects moving a node into its own subtree (would create a parent cycle)", () => {
    const s = setup({ a: { b: { c: "leaf!" } }, other: "xxxxxx" });
    const before = s.tree.toJson();
    expect(() => s.mutator.move({ path: "/a" }, { path: "/a/b" }, "loop")).toThrow(InvalidOpError);
    expect(s.tree.toJson()).toEqual(before); // nothing detached, nothing lost
    // parent chain still terminates (this hung forever pre-fix)
    expect(s.addressing.pathOf(s.addressing.byPath("/a/b/c")!.id)).toBe("/a/b/c");
    expect(s.log.length()).toBe(0); // nothing logged
  });

  it("rejects moving a node onto itself", () => {
    const s = setup({ a: { x: "1" }, b: {} });
    expect(() => s.mutator.move({ path: "/a" }, { path: "/a" }, "self")).toThrow(InvalidOpError);
  });

  it("rejects a move onto an existing object key (would silently shadow it)", () => {
    const s = setup({ src: { x: "hello!" }, dst: { k: "old-value", other: 22 } });
    const before = s.tree.toJson();
    expect(() => s.mutator.move({ path: "/src/x" }, { path: "/dst" }, "k")).toThrow(InvalidOpError);
    expect(s.tree.toJson()).toEqual(before);
    expect(s.tree.toJson(s.addressing.byPath("/dst/k")!.id)).toBe("old-value");
  });

  it("rejects a non-string key for an object move BEFORE detaching (no orphan)", () => {
    const s = setup({ src: { x: "hello!" }, dst: { other: 22 } });
    const before = s.tree.toJson();
    expect(() => s.mutator.move({ path: "/src/x" }, { path: "/dst" }, 0)).toThrow(InvalidOpError);
    expect(s.tree.toJson()).toEqual(before); // pre-fix: x was detached and lost
  });

  it("still allows a move onto the node's own current key (no-op reattach)", () => {
    const s = setup({ a: { x: "1" }, b: {} });
    s.mutator.move({ path: "/a/x" }, { path: "/a" }, "x");
    expect(s.tree.toJson()).toEqual({ a: { x: "1" }, b: {} });
  });

  it("legal cross-parent move still works and logs a move event", () => {
    const s = setup({ a: { x: "1" }, b: {} });
    s.mutator.move({ path: "/a/x" }, { path: "/b" }, "x");
    expect(s.tree.toJson()).toEqual({ a: {}, b: { x: "1" } });
    expect(s.log.entries().at(-1)!.kind).toBe("move");
  });

  it("surfaces as INVALID_OP through toolset patch (agent traffic)", async () => {
    const s = setup({ a: { b: {} } });
    const ts = makeToolset({ tree: s.tree, addressing: s.addressing, log: s.log, mutator: s.mutator });
    const r = await ts.patch({ path: "/a" }, { op: "move", to: { path: "/a/b" }, key: "loop" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_OP");
  });
});
