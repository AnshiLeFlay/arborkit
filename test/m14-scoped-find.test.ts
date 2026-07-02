import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { makeToolset } from "../src/toolset";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function setup() {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson(
    { a: { x: "1", y: "2", z: "3" }, scoped: { hit1: "h1", hit2: "h2" } },
    deps,
  );
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0) });
  return { tree, addressing, log, mutator };
}

describe("M14 scoped find", () => {
  it("returns in-scope matches even when out-of-scope nodes would exhaust the limit", async () => {
    const s = setup();
    const ts = makeToolset(
      { tree: s.tree, addressing: s.addressing, log: s.log, mutator: s.mutator },
      { readScope: "/scoped" },
    );
    const r = await ts.find({ pathPattern: "/**" }, { limit: 3 });
    expect(r.ok).toBe(true);
    // pre-fix: [] — the limit was consumed by /a's out-of-scope hits, then filtered away
    if (r.ok) expect(r.value.map((h) => h.path).sort()).toEqual(["/scoped", "/scoped/hit1", "/scoped/hit2"]);
  });

  it("unscoped find is unchanged (within undefined)", async () => {
    const s = setup();
    const ts = makeToolset({ tree: s.tree, addressing: s.addressing, log: s.log, mutator: s.mutator });
    const r = await ts.find({ pathPattern: "/scoped/*" });
    if (r.ok) expect(r.value.map((h) => h.path).sort()).toEqual(["/scoped/hit1", "/scoped/hit2"]);
  });
});
