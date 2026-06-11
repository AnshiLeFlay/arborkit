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

describe("Toolset.describe / get", () => {
  it("describe with no ref defaults to readScope and lists its children", async () => {
    const { toolset } = setup({ pages: { home: {}, about: {} }, other: {} }, { readScope: "/pages" });
    const r = await toolset.describe();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.children.map((c) => c.key).sort()).toEqual(["about", "home"]);
  });

  it("describe with no ref and no readScope defaults to the root", async () => {
    const { toolset } = setup({ a: 1, b: 2 });
    const r = await toolset.describe();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.node.path).toBe("");
  });

  it("get returns a value with a CLONED meta (mutating it does not affect the tree)", async () => {
    const { tree, addressing, toolset } = setup({ a: "x" });
    const r = await toolset.get({ path: "/a" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      r.value.meta.version = 999;
      expect(addressing.byPath("/a")!.meta.version).toBe(0);
    }
  });

  it("get outside readScope returns a structured SCOPE_VIOLATION error (no throw)", async () => {
    const { toolset } = setup({ pages: { home: "h" }, secret: "s" }, { readScope: "/pages" });
    const r = await toolset.get({ path: "/secret" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SCOPE_VIOLATION");
  });

  it("a missing ref returns a structured NODE_NOT_FOUND error", async () => {
    const { toolset } = setup({ a: "x" });
    const r = await toolset.get({ path: "/nope" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NODE_NOT_FOUND");
  });
});
