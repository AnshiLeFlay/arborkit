import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { Replay } from "../src/replay";
import { makeToolset } from "../src/toolset";
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

describe("M14 aliasing hygiene", () => {
  it("mutating the caller's object after set() changes neither the tree nor history", () => {
    const s = setup({ x: null });
    const v = { a: 1 };
    s.mutator.set({ path: "/x" }, v);
    v.a = 999; // caller keeps mutating their object
    expect(s.tree.toJson()).toEqual({ x: { a: 1 } });
    expect(s.log.entries()[0]!.after).toEqual({ a: 1 });
    expect(new Replay(s.tree, s.log).getAt("/x", 1)).toEqual({ a: 1 });
  });

  it("mutating the caller's object after insert() does not leak into the tree", () => {
    const s = setup({ docs: {} });
    const v = { body: "hi" };
    s.mutator.insert({ path: "/docs" }, "a", v);
    v.body = "VANDALIZED";
    expect(s.tree.toJson()).toEqual({ docs: { a: { body: "hi" } } });
    expect(s.log.entries()[0]!.after).toEqual({ body: "hi" });
  });

  it("mutating a reconstruction does not corrupt the log's before values", () => {
    const s = setup({ x: null });
    s.mutator.set({ path: "/x" }, { a: 1 }); // seq 0
    s.mutator.set({ path: "/x" }, { a: 2 }); // seq 1: before = {a:1}
    const replay = new Replay(s.tree, s.log);
    const v1 = replay.reconstructValueAt(1) as { x: { a: number } };
    v1.x.a = 777; // vandalize the reconstruction
    expect(replay.getAt("/x", 1)).toEqual({ a: 1 }); // history unharmed
  });

  it("toolset history returns clones — events cannot be corrupted by the caller", async () => {
    const s = setup({ x: null });
    s.mutator.set({ path: "/x" }, { a: 1 });
    const ts = makeToolset({ tree: s.tree, addressing: s.addressing, log: s.log, mutator: s.mutator });
    const r1 = await ts.history();
    expect(r1.ok).toBe(true);
    if (r1.ok) (r1.value[0]!.after as { a: number }).a = 666;
    const r2 = await ts.history();
    if (r2.ok) expect(r2.value[0]!.after).toEqual({ a: 1 });
  });

  it("mutating the caller's tags array after set() changes neither the node nor history", () => {
    const s = setup({ x: null });
    const t = ["draft"];
    s.mutator.set({ path: "/x" }, "v", { tags: t });
    t.push("INJECTED");
    expect(s.addressing.byPath("/x")!.tags).toEqual(["draft"]);
    expect(s.log.at(0)!.tags).toEqual(["draft"]);
  });
});
