import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { SemanticIndex } from "../src/semantic-index";
import { MockEmbeddingPort } from "../src/embedding-port";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { TypeRegistry } from "../src/type-registry";
import { typeAwareDecision } from "../src/type-aware-decision";
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

function setupWithRegistry() {
  const registry = new TypeRegistry();
  const clock = new FixedClock(0);
  const deps: TreeDeps = {
    idGen: new SeqIdGen(),
    clock,
    decision: typeAwareDecision(sizeBasedDecision(1), registry),
  };
  const tree = ArtifactTree.fromJson({ docs: {} }, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const index = new SemanticIndex(tree, addressing, new MockEmbeddingPort(), new MemoryVectorIndex(), registry);
  const mutator = new Mutator(tree, addressing, log, { clock, ...index.hooks() });
  return { tree, addressing, index, mutator, registry };
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

describe("M10 C2: grandchild shards are suppressed (Hole 1 regression)", () => {
  it("grandchild text-leaves under a typed embedText node do not appear in search results", async () => {
    const { index, mutator, registry } = setupWithRegistry();
    // Page has embedText (title only) but NO decompose override — so the object
    // is still split by size (sizeBasedDecision(1)). The decomposition produces
    // grandchildren like /docs/page/nested/deep which must NOT be indexed.
    registry.register("Page", {
      embedText: (v) => String((v as { title?: unknown }).title ?? ""),
    });
    mutator.insert({ path: "/docs" }, "page", { title: "alpha", nested: { deep: "secret grandchild text" } }, { type: "Page" });
    // Only the Page node itself should be stale — children/grandchildren suppressed.
    expect(index.staleCount()).toBe(1);
    await index.reindex();
    const r = await index.search("secret grandchild text", { freshness: "wait" });
    // No shard path under /docs/page (other than /docs/page itself) should appear.
    const shardHits = r.results.filter(
      (h) => h.path.startsWith("/docs/page/"),
    );
    expect(shardHits).toHaveLength(0);
  });
});

describe("M10 C3: self-typed child is NOT suppressed (Hole 2 regression)", () => {
  it("a child node that itself has a typed embedText is still indexed", async () => {
    const { index, mutator, registry, addressing } = setupWithRegistry();
    registry.register("Outer", {
      embedText: (v) => String((v as { title?: unknown }).title ?? ""),
    });
    registry.register("Inner", {
      embedText: (v) => String((v as { content?: unknown }).content ?? ""),
      decompose: "opaque",
    });
    // Insert outer typed node — it decomposes (no decompose override, size > 1).
    mutator.insert({ path: "/docs" }, "container", { title: "outer title", sub: {} }, { type: "Outer" });
    await index.reindex();
    // Now set the /docs/container/sub child as an Inner semantic unit.
    const subNode = addressing.byPath("/docs/container/sub");
    expect(subNode).not.toBeNull();
    mutator.set({ path: "/docs/container/sub" }, { content: "inner unique text" }, { type: "Inner" });
    // The Inner node must be stale (not suppressed by the Outer ancestor).
    expect(index.staleCount()).toBe(1);
    await index.reindex();
    const r = await index.search("inner unique text", { freshness: "wait" });
    expect(r.results.some((h) => h.path === "/docs/container/sub")).toBe(true);
  });
});
