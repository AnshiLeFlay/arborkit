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
import type { Json } from "../src/types";

/** The typed unit's embed text derives from its WHOLE subtree, so any shard
 *  change must change the ancestor's hash. */
const docEmbedText = (v: Json): string => JSON.stringify(v);

function setup(initial: Json) {
  const registry = new TypeRegistry();
  registry.register("doc", { embedText: docEmbedText, decompose: "children" });
  const clock = new FixedClock(0);
  const deps: TreeDeps = {
    idGen: new SeqIdGen(),
    clock,
    decision: typeAwareDecision(sizeBasedDecision(1), registry),
  };
  const tree = ArtifactTree.fromJson(initial, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const vectors = new MemoryVectorIndex();
  const index = new SemanticIndex(tree, addressing, new MockEmbeddingPort(), vectors, registry);
  const mutator = new Mutator(tree, addressing, log, { clock, ...index.hooks() });
  return { tree, addressing, log, mutator, index, vectors, registry };
}

/** Inner unit: its own embed text, distinct from the outer doc's. */
const sectionEmbedText = (v: Json): string => `SECTION:${JSON.stringify(v)}`;

function setupNested(outerEmbedText: (v: Json) => string = docEmbedText) {
  const registry = new TypeRegistry();
  registry.register("doc", { embedText: outerEmbedText, decompose: "children" });
  registry.register("section", { embedText: sectionEmbedText, decompose: "children" });
  const clock = new FixedClock(0);
  const deps: TreeDeps = {
    idGen: new SeqIdGen(),
    clock,
    decision: typeAwareDecision(sizeBasedDecision(1), registry),
  };
  const tree = ArtifactTree.fromJson({ docs: {} }, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const vectors = new MemoryVectorIndex();
  const index = new SemanticIndex(tree, addressing, new MockEmbeddingPort(), vectors, registry);
  const mutator = new Mutator(tree, addressing, log, { clock, ...index.hooks() });
  // outer doc unit with a nested inner section unit
  mutator.insert({ path: "/docs" }, "a", { title: "alpha title" }, { type: "doc" });
  mutator.insert({ path: "/docs/a" }, "sections", {});
  mutator.insert({ path: "/docs/a/sections" }, "s1", { heading: "head", body: "old body" }, { type: "section" });
  return { tree, addressing, log, mutator, index, vectors, registry };
}

describe("nested embedText units: staleness propagates past the nearest owner", () => {
  it("a write inside the inner unit marks BOTH the inner and outer units stale; reindex refreshes both", async () => {
    const s = setupNested();
    await s.index.reindex();
    const doc = s.addressing.byPath("/docs/a")!;
    const section = s.addressing.byPath("/docs/a/sections/s1")!;
    expect(doc.meta.embedding.state).toBe("fresh");
    expect(section.meta.embedding.state).toBe("fresh");

    s.mutator.set({ path: "/docs/a/sections/s1/body" }, "brand new nested body");

    expect(section.meta.embedding.state).toBe("stale");
    // Pre-fix: only the NEAREST owning unit was re-marked — the outer doc kept
    // its old vector even though its embed text covers the section's content.
    expect(doc.meta.embedding.state).toBe("stale");

    await s.index.reindex();
    expect(doc.meta.embedding.state).toBe("fresh");
    expect(section.meta.embedding.state).toBe("fresh");

    // Search reflects the updated content on both units.
    const docQuery = docEmbedText(s.tree.toJson(doc.id));
    const rDoc = await s.index.search(docQuery);
    expect(rDoc.results[0]?.path).toBe("/docs/a");
    const sectionQuery = sectionEmbedText({ heading: "head", body: "brand new nested body" });
    const rSection = await s.index.search(sectionQuery);
    expect(rSection.results[0]?.path).toBe("/docs/a/sections/s1");
  });

  it("no over-marking: a plain-shard write under a SINGLE unit marks exactly that unit", async () => {
    const s = setup({ docs: {} });
    s.mutator.insert({ path: "/docs" }, "a", { title: "title a", body: "body a" }, { type: "doc" });
    s.mutator.insert({ path: "/docs" }, "b", { title: "title b", body: "body b" }, { type: "doc" });
    await s.index.reindex();
    const docA = s.addressing.byPath("/docs/a")!;
    const docB = s.addressing.byPath("/docs/b")!;

    s.mutator.set({ path: "/docs/a/body" }, "changed body a");

    expect(docA.meta.embedding.state).toBe("stale");
    expect(docB.meta.embedding.state).toBe("fresh");
    expect(s.index.staleCount()).toBe(1);
  });

  it("textHash dedupe: an outer unit whose recomputed text is unchanged stays fresh (no false staleness)", async () => {
    // Outer embed text derives ONLY from the title — an inner-body write leaves it unchanged.
    const titleOnly = (v: Json): string => String((v as { title: string }).title);
    const s = setupNested(titleOnly);
    await s.index.reindex();
    const doc = s.addressing.byPath("/docs/a")!;
    const section = s.addressing.byPath("/docs/a/sections/s1")!;

    s.mutator.set({ path: "/docs/a/sections/s1/body" }, "brand new nested body");

    expect(section.meta.embedding.state).toBe("stale");
    // Recomputed outer text (the title) is hash-identical — the dedupe settles it
    // without ever queueing a re-embed.
    expect(doc.meta.embedding.state).toBe("fresh");
    expect(s.index.staleCount()).toBe(1);
  });
});

describe("M17 T1: typed-ancestor staleness propagation", () => {
  it("setting a shard re-marks the owning embedText ancestor stale; search reflects the new text", async () => {
    const s = setup({ docs: {} });
    s.mutator.insert({ path: "/docs" }, "a", { title: "old alpha title", body: "beta body" }, { type: "doc" });
    await s.index.reindex();
    const doc = s.addressing.byPath("/docs/a")!;
    expect(doc.meta.embedding.state).toBe("fresh");

    s.mutator.set({ path: "/docs/a/title" }, "brand new gamma title");

    // Pre-fix: the ancestor stayed fresh with the OLD vector (silent drift).
    expect(doc.meta.embedding.state).toBe("stale");
    expect(s.index.staleCount()).toBeGreaterThanOrEqual(1);

    await s.index.reindex();
    expect(doc.meta.embedding.state).toBe("fresh");
    const query = docEmbedText({ title: "brand new gamma title", body: "beta body" });
    const r = await s.index.search(query);
    expect(r.results[0]?.path).toBe("/docs/a");
  });

  it("removing a shard re-marks the owning embedText ancestor stale", async () => {
    const s = setup({ docs: {} });
    s.mutator.insert({ path: "/docs" }, "a", { title: "some title", body: "some body" }, { type: "doc" });
    await s.index.reindex();
    const doc = s.addressing.byPath("/docs/a")!;
    expect(doc.meta.embedding.state).toBe("fresh");

    s.mutator.remove({ path: "/docs/a/body" });

    // Pre-fix: remove never told the ancestor its subtree shrank.
    expect(doc.meta.embedding.state).toBe("stale");
  });

  it("moving a node INTO a typed subtree drops its own vector and marks the ancestor stale", async () => {
    const s = setup({ docs: {} });
    s.mutator.insert({ path: "" }, "note", "floating note text");
    s.mutator.insert({ path: "/docs" }, "a", { title: "some title", body: "some body" }, { type: "doc" });
    await s.index.reindex();
    const doc = s.addressing.byPath("/docs/a")!;
    const note = s.addressing.byPath("/note")!;
    expect(note.meta.embedding.state).toBe("fresh");
    expect(await s.vectors.has(note.id)).toBe(true);

    s.mutator.move({ path: "/note" }, { path: "/docs/a" }, "extra");

    // Pre-fix: move fired no hooks — the leaf kept a live vector and the
    // ancestor kept the pre-move one.
    expect(note.meta.embedding.state).toBe("none"); // now a suppressed shard
    expect(doc.meta.embedding.state).toBe("stale");

    await s.index.reindex();
    expect(await s.vectors.has(note.id)).toBe(false); // shard vector dropped
    expect(doc.meta.embedding.state).toBe("fresh");
  });

  it("moving a shard OUT of the typed subtree marks the old ancestor stale and frees the node to embed itself", async () => {
    const s = setup({ docs: {} });
    s.mutator.insert({ path: "/docs" }, "a", { title: "some title", body: "unique escaped body text" }, { type: "doc" });
    await s.index.reindex();
    const doc = s.addressing.byPath("/docs/a")!;
    const body = s.addressing.byPath("/docs/a/body")!;
    expect(body.meta.embedding.state).toBe("none"); // suppressed while inside

    s.mutator.move({ path: "/docs/a/body" }, { path: "" }, "solo");

    // Pre-fix: neither side learned anything from the move.
    expect(doc.meta.embedding.state).toBe("stale"); // old ancestor lost content
    expect(body.meta.embedding.state).toBe("stale"); // independently embeddable now

    await s.index.reindex();
    expect(body.meta.embedding.state).toBe("fresh");
    const r = await s.index.search("unique escaped body text");
    expect(r.results[0]?.path).toBe("/solo");
  });
});
