import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { SemanticIndex } from "../src/semantic-index";
import { MockEmbeddingPort } from "../src/embedding-port";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { makeToolset, type ToolsetBinding } from "../src/toolset";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function setup(json: unknown, binding: ToolsetBinding = {}, withIndex = true) {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson(json as never, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const index = withIndex ? new SemanticIndex(tree, addressing, new MockEmbeddingPort(), new MemoryVectorIndex()) : undefined;
  const mutator = new Mutator(tree, addressing, log, { clock, ...(index ? index.hooks() : {}) });
  const toolset = makeToolset({ tree, addressing, log, mutator, index }, binding);
  return { tree, addressing, log, mutator, index, toolset };
}

describe("Toolset.find", () => {
  it("finds by tag and filters hits to readScope", async () => {
    const { mutator, toolset } = setup({ a: {}, b: {} }, { readScope: "/a" });
    mutator.insert({ path: "/a" }, "x", "1", { tags: ["t"] });
    mutator.insert({ path: "/b" }, "y", "2", { tags: ["t"] });
    const r = await toolset.find({ tag: "t" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((h) => h.path)).toEqual(["/a/x"]);
  });
});

describe("Toolset.search", () => {
  it("returns semantic results, scoped to readScope via under", async () => {
    const { mutator, index, toolset } = setup({ docs: {}, junk: {} }, { readScope: "/docs" });
    mutator.insert({ path: "/docs" }, "a", "the quick brown fox");
    mutator.insert({ path: "/junk" }, "b", "the quick brown fox");
    await index!.reindex();
    const r = await toolset.search("the quick brown fox");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.results.every((h) => h.path.startsWith("/docs"))).toBe(true);
  });

  it("returns INVALID_OP when the toolset has no semantic index", async () => {
    const { toolset } = setup({ a: 1 }, {}, false);
    const r = await toolset.search("anything");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_OP");
  });
});
