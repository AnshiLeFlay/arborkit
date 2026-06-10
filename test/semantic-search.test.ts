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
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson({ docs: {} }, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const index = new SemanticIndex(tree, addressing, new MockEmbeddingPort(), new MemoryVectorIndex());
  const mutator = new Mutator(tree, addressing, log, { clock, ...index.hooks() });
  return { tree, addressing, index, mutator };
}

describe("SemanticIndex.search", () => {
  it("ranks the node whose text matches the query first", async () => {
    const { index, mutator } = setup();
    mutator.insert({ path: "/docs" }, "a", "the quick brown fox");
    mutator.insert({ path: "/docs" }, "b", "lorem ipsum dolor");
    await index.reindex();
    const r = await index.search("the quick brown fox");
    expect(r.results[0].path).toBe("/docs/a");
    expect(r.results[0].score).toBeCloseTo(1, 5);
    expect(r.staleCount).toBe(0);
  });

  it("best-effort search reports staleCount without reindexing", async () => {
    const { index, mutator } = setup();
    mutator.insert({ path: "/docs" }, "a", "hello");
    const r = await index.search("hello");
    expect(r.staleCount).toBe(1);
    expect(r.results.length).toBe(0);
  });

  it("freshness 'wait' reindexes before searching", async () => {
    const { index, mutator } = setup();
    mutator.insert({ path: "/docs" }, "a", "hello");
    const r = await index.search("hello", { freshness: "wait" });
    expect(r.staleCount).toBe(0);
    expect(r.results[0].path).toBe("/docs/a");
  });

  it("respects k", async () => {
    const { index, mutator } = setup();
    mutator.insert({ path: "/docs" }, "a", "alpha text");
    mutator.insert({ path: "/docs" }, "b", "beta text");
    mutator.insert({ path: "/docs" }, "c", "gamma text");
    await index.reindex();
    const r = await index.search("text", { k: 2 });
    expect(r.results.length).toBe(2);
  });

  it("post-filters by under (JSON-Pointer prefix)", async () => {
    const { index, mutator } = setup();
    mutator.insert({ path: "" }, "other", {}, {});
    mutator.insert({ path: "/docs" }, "a", "shared text");
    mutator.insert({ path: "/other" }, "b", "shared text");
    await index.reindex();
    const r = await index.search("shared text", { under: "/docs" });
    expect(r.results.every((h) => h.path.startsWith("/docs"))).toBe(true);
    expect(r.results.map((h) => h.path)).toContain("/docs/a");
  });
});
