import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { SemanticIndex } from "../src/semantic-index";
import { MockEmbeddingPort } from "../src/embedding-port";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function setup() {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson({ docs: {} }, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const index = new SemanticIndex(tree, addressing, new MockEmbeddingPort(), new MemoryVectorIndex());
  const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0), ...index.hooks() });
  return { tree, addressing, index, mutator };
}

describe("M10 C1: decomposed children get indexed", () => {
  it("inserting a decomposing container makes its text-leaf children searchable", async () => {
    const { index, mutator } = setup();
    // threshold 1 → this object decomposes into child nodes; the strings are the leaves
    mutator.insert({ path: "/docs" }, "page", { title: "alpha beta", body: "gamma delta" });
    expect(index.staleCount()).toBeGreaterThanOrEqual(2); // both text leaves queued
    await index.reindex();
    const r = await index.search("alpha beta");
    expect(r.results.some((h) => h.path === "/docs/page/title")).toBe(true);
  });

  it("a set that re-decomposes also queues the NEW children", async () => {
    const { index, mutator } = setup();
    mutator.insert({ path: "/docs" }, "page", { title: "first" });
    await index.reindex();
    mutator.set({ path: "/docs/page" }, { title: "second wind", extra: "more text here" });
    expect(index.staleCount()).toBeGreaterThanOrEqual(2);
    await index.reindex();
    const r = await index.search("second wind");
    expect(r.results.some((h) => h.path === "/docs/page/title")).toBe(true);
  });
});
