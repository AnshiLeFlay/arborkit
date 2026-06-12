import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { makeToolset } from "../src/toolset";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { SystemClock } from "../src/clock";

describe("M10 I1: toolset.get returns no live references", () => {
  it("mutating the returned content does not change the tree and logs no event", async () => {
    const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new SystemClock(), decision: sizeBasedDecision(1) };
    const tree = ArtifactTree.fromJson({ pages: {} }, deps);
    const addressing = new Addressing(tree);
    const log = new EventLog();
    const mutator = new Mutator(tree, addressing, log, { clock: deps.clock });
    const tools = makeToolset({ tree, addressing, log, mutator }, { writeScope: "/pages" });

    await tools.patch({ path: "/pages" }, { op: "insert", key: "home", value: { title: "Home" } });
    const logLenBefore = log.length();

    const got = await tools.get({ path: "/pages/home" });
    expect(got.ok).toBe(true);
    if (got.ok) {
      (got.value.content as Record<string, unknown>)["injected"] = "HACKED";
      got.value.meta.version = 999;
    }

    expect(tree.toJson()).toEqual({ pages: { home: { title: "Home" } } }); // tree untouched
    expect(log.length()).toBe(logLenBefore); // no event sneaked in
  });
});
