import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { makeToolset } from "../src/toolset";
import { sizeBasedDecision } from "../src/decompose";
import { typeAwareDecision } from "../src/type-aware-decision";
import { TypeRegistry } from "../src/type-registry";
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

  it("mutating the content of an opaque-leaf node does not change the tree (live-reference leak)", async () => {
    // With sizeBasedDecision(1), object containers decompose into child nodes so
    // Navigator.reconstruct() builds fresh objects — the live-reference leak does NOT
    // manifest for decomposed containers. The leak ONLY occurs for OPAQUE LEAF nodes
    // whose content is an object/array: reconstruct returns n.content directly.
    //
    // To create an opaque object leaf we use typeAwareDecision: type "Blob" is
    // registered with decompose:"opaque", so mutator.set({type:"Blob"}) stores
    // {title:"Home"} as a single leaf node with content={title:"Home"} — exactly
    // the case where reconstruct returns the object by reference.
    const registry = new TypeRegistry();
    registry.register("Blob", { decompose: "opaque" });
    const deps: TreeDeps = {
      idGen: new SeqIdGen(),
      clock: new SystemClock(),
      decision: typeAwareDecision(sizeBasedDecision(1), registry),
    };
    const tree = ArtifactTree.fromJson({ pages: {} }, deps);
    const addressing = new Addressing(tree);
    const log = new EventLog();
    const mutator = new Mutator(tree, addressing, log, { clock: deps.clock });
    const tools = makeToolset({ tree, addressing, log, mutator }, { writeScope: "/pages" });

    // Insert then set with type "Blob" → opaque leaf with content = {title:"Home"}
    mutator.insert({ path: "/pages" }, "home", { title: "Home" }, { type: "Blob" });
    const logLenBefore = log.length();

    const got = await tools.get({ path: "/pages/home" });
    expect(got.ok).toBe(true);
    if (got.ok) {
      // Mutate the returned content — without structuredClone this would reach the live tree.
      (got.value.content as Record<string, unknown>)["injected"] = "HACKED";
    }

    // Without structuredClone, got.value.content IS the live node.content object,
    // so toJson() would return { pages: { home: { title: "Home", injected: "HACKED" } } }.
    expect(tree.toJson()).toEqual({ pages: { home: { title: "Home" } } });
    expect(log.length()).toBe(logLenBefore); // no spurious event logged
  });
});
