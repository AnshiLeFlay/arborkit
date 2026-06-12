import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { Replay } from "../src/replay";
import { TypeRegistry } from "../src/type-registry";
import { makeRegistryValidator } from "../src/registry-validator";
import { zodValidate } from "../src/zod-adapter";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";
import { z } from "zod";

function setup() {
  const registry = new TypeRegistry();
  registry.register("Page", {
    decompose: "opaque",
    validate: zodValidate(z.object({ title: z.string() }), "Page"),
  });
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson({ pages: { draft: null } }, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock, validate: makeRegistryValidator(registry) });
  return { tree, addressing, log, mutator };
}

describe("M10: type-aware revert", () => {
  it("set with { type: null } clears the node's type and skips validation", () => {
    const { addressing, mutator } = setup();
    mutator.set({ path: "/pages/draft" }, { title: "ok" }, { type: "Page" });
    expect(addressing.byPath("/pages/draft")!.type).toBe("Page");
    mutator.set({ path: "/pages/draft" }, "free text now", { type: null }); // would fail Page validation
    expect(addressing.byPath("/pages/draft")!.type).toBeUndefined();
  });

  it("reverting a typed node to its pre-type null state works WITHOUT any external workaround", () => {
    const { tree, addressing, log, mutator } = setup();
    const v0 = log.length(); // /pages/draft is null and untyped here
    mutator.set({ path: "/pages/draft" }, { title: "Hello" }, { type: "Page" });

    const replay = new Replay(tree, log);
    replay.revert(mutator, addressing, { path: "/pages/draft" }, v0); // used to throw ValidationError

    const node = addressing.byPath("/pages/draft")!;
    expect(tree.toJson(node.id)).toBeNull();
    expect(node.type).toBeUndefined(); // type restored to "untyped", not just value
  });

  it("a value→value revert keeps the type and still validates", () => {
    const { tree, addressing, log, mutator } = setup();
    mutator.set({ path: "/pages/draft" }, { title: "v1" }, { type: "Page" });
    const v1 = log.length();
    mutator.set({ path: "/pages/draft" }, { title: "v2" });

    new Replay(tree, log).revert(mutator, addressing, { path: "/pages/draft" }, v1);
    const node = addressing.byPath("/pages/draft")!;
    expect(tree.toJson(node.id)).toEqual({ title: "v1" });
    expect(node.type).toBe("Page");
  });

  it("set events record nodeTypeBefore/nodeType (null = untyped)", () => {
    const { log, mutator } = setup();
    mutator.set({ path: "/pages/draft" }, { title: "x" }, { type: "Page" });
    const e = log.entries()[0];
    expect(e.nodeTypeBefore).toBeNull(); // was untyped
    expect(e.nodeType).toBe("Page");
  });
});
