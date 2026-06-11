import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { SemanticIndex } from "../src/semantic-index";
import { MockEmbeddingPort } from "../src/embedding-port";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { makeToolset } from "../src/toolset";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function world() {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson({ pages: { home: {} }, brandFacts: {} }, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const index = new SemanticIndex(tree, addressing, new MockEmbeddingPort(), new MemoryVectorIndex());
  const mutator = new Mutator(tree, addressing, log, { clock, ...index.hooks() });
  // seed a brand fact (unscoped admin write)
  mutator.insert({ path: "/brandFacts" }, "price", "2990", { tags: ["brand-fact:price"] });
  return { tree, addressing, log, mutator, index };
}

describe("M8 toolset integration", () => {
  it("a writer scoped to /pages/home can edit its page but not a sibling or brandFacts", async () => {
    const w = world();
    const writer = makeToolset(w, { owner: "content-writer", writeScope: "/pages/home", readScope: undefined });

    // can read brandFacts globally (readScope unset)
    const facts = await writer.find({ tag: "brand-fact:price" });
    expect(facts.ok && facts.value.map((h) => h.path)).toEqual(["/brandFacts/price"]);

    // can write its own page
    const ins = await writer.patch({ path: "/pages/home" }, { op: "insert", key: "title", value: "Welcome" });
    expect(ins.ok).toBe(true);
    expect(w.tree.toJson()).toEqual({ pages: { home: { title: "Welcome" } }, brandFacts: { price: "2990" } });

    // cannot write outside its scope
    const bad = await writer.patch({ path: "/brandFacts/price" }, { op: "set", value: "0" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("SCOPE_VIOLATION");
    expect((w.tree.toJson() as { brandFacts: unknown }).brandFacts).toEqual({ price: "2990" }); // unchanged
  });

  it("a reader scoped to /pages sees pages and searches within them; get returns a cloned meta", async () => {
    const w = world();
    const writer = makeToolset(w, { owner: "w", writeScope: "/pages/home" });
    await writer.patch({ path: "/pages/home" }, { op: "insert", key: "body", value: "pricing details and plans" });
    await w.index.reindex();

    const reader = makeToolset(w, { readScope: "/pages" });
    const found = await reader.search("pricing details and plans");
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.value.results.every((h) => h.path.startsWith("/pages"))).toBe(true);

    const got = await reader.get({ path: "/pages/home/body" });
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.value.content).toBe("pricing details and plans");
      got.value.meta.version = -1; // mutate the boundary copy
      expect(w.addressing.byPath("/pages/home/body")!.meta.version).not.toBe(-1);
    }
  });
});
