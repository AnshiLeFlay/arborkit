import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { SemanticIndex } from "../src/semantic-index";
import { MockEmbeddingPort } from "../src/embedding-port";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { TypeRegistry } from "../src/type-registry";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function setup() {
  const registry = new TypeRegistry();
  registry.register("PageContent", {
    embedText: (v) => {
      const o = v as { title?: string; body?: string };
      return `${o.title ?? ""} ${o.body ?? ""}`.trim();
    },
  });
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson({ pages: {} }, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const index = new SemanticIndex(tree, addressing, new MockEmbeddingPort(), new MemoryVectorIndex(), registry);
  const mutator = new Mutator(tree, addressing, log, { clock, ...index.hooks() });
  return { tree, addressing, index, mutator };
}

describe("M5 semantic integration", () => {
  it("indexes typed pages via embedText and finds the right one by meaning", async () => {
    const { index, mutator } = setup();
    mutator.insert({ path: "/pages" }, "home", { title: "Welcome home", body: "intro" }, { type: "PageContent" });
    mutator.insert({ path: "/pages" }, "pricing", { title: "Pricing plans", body: "cost" }, { type: "PageContent" });
    await index.reindex();
    const r = await index.search("Pricing plans cost");
    expect(r.results[0].path).toBe("/pages/pricing");
    expect(r.staleCount).toBe(0);
  });

  it("a set that changes content re-stales and reindex refreshes the vector", async () => {
    const { addressing, index, mutator } = setup();
    mutator.insert({ path: "/pages" }, "home", { title: "Old title", body: "x" }, { type: "PageContent" });
    await index.reindex();
    expect(index.staleCount()).toBe(0);
    const homeId = addressing.byPath("/pages/home")!.id;
    mutator.set({ id: homeId }, { title: "Brand new headline", body: "x" }, { type: "PageContent" });
    expect(index.staleCount()).toBe(1);
    await index.reindex();
    const r = await index.search("Brand new headline", { freshness: "wait" });
    expect(r.results[0].path).toBe("/pages/home");
  });

  it("removing a page drops it from search results", async () => {
    const { addressing, index, mutator } = setup();
    mutator.insert({ path: "/pages" }, "home", { title: "Home", body: "h" }, { type: "PageContent" });
    mutator.insert({ path: "/pages" }, "gone", { title: "Temporary", body: "t" }, { type: "PageContent" });
    await index.reindex();
    const goneId = addressing.byPath("/pages/gone")!.id;
    mutator.remove({ id: goneId });
    const r = await index.search("Temporary", { freshness: "wait" });
    expect(r.results.map((h) => h.path)).not.toContain("/pages/gone");
  });
});
