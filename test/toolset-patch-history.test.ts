import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { makeToolset, type ToolsetBinding } from "../src/toolset";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function setup(json: unknown, binding: ToolsetBinding = {}) {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson(json as never, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock });
  const toolset = makeToolset({ tree, addressing, log, mutator }, binding);
  return { tree, addressing, log, mutator, toolset };
}

describe("Toolset.patch", () => {
  it("set applies within writeScope and stamps owner", async () => {
    const { tree, addressing, toolset } = setup({ pages: { a: "old" } }, { writeScope: "/pages/a", owner: "agent-1" });
    const r = await toolset.patch({ path: "/pages/a" }, { op: "set", value: "new" });
    expect(r.ok).toBe(true);
    expect(tree.toJson()).toEqual({ pages: { a: "new" } });
    expect(addressing.byPath("/pages/a")!.meta.owner).toBe("agent-1");
  });

  it("insert returns the new node id", async () => {
    const { tree, toolset } = setup({ docs: {} });
    const r = await toolset.patch({ path: "/docs" }, { op: "insert", key: "k", value: "v" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(typeof r.value.id).toBe("string");
    expect(tree.toJson()).toEqual({ docs: { k: "v" } });
  });

  it("a write outside writeScope returns a structured SCOPE_VIOLATION and changes nothing", async () => {
    const { tree, toolset } = setup({ pages: { a: "x", b: "y" } }, { writeScope: "/pages/a" });
    const r = await toolset.patch({ path: "/pages/b" }, { op: "set", value: "z" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SCOPE_VIOLATION");
    expect(tree.toJson()).toEqual({ pages: { a: "x", b: "y" } });
  });

  it("remove and move work", async () => {
    const { tree, addressing, toolset } = setup({ from: { x: "v" }, to: {} });
    const xId = addressing.byPath("/from/x")!.id;
    expect((await toolset.patch({ id: xId }, { op: "move", to: { path: "/to" }, key: "x" })).ok).toBe(true);
    expect(tree.toJson()).toEqual({ from: {}, to: { x: "v" } });
    expect((await toolset.patch({ path: "/to/x" }, { op: "remove" })).ok).toBe(true);
    expect(tree.toJson()).toEqual({ from: {}, to: {} });
  });
});

describe("Toolset.history", () => {
  it("returns all events, or those touching a given node", async () => {
    const { addressing, toolset, mutator } = setup({ docs: {} });
    mutator.insert({ path: "/docs" }, "a", "1");
    mutator.insert({ path: "/docs" }, "b", "2");
    const aId = addressing.byPath("/docs/a")!.id;
    const all = await toolset.history();
    expect(all.ok).toBe(true);
    if (all.ok) expect(all.value.length).toBe(2);
    const justA = await toolset.history({ id: aId });
    expect(justA.ok).toBe(true);
    if (justA.ok) expect(justA.value.every((e) => e.targetId === aId)).toBe(true);
  });
});
