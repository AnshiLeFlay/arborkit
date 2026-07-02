import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { TypeRegistry } from "../src/type-registry";
import { typeAwareDecision } from "../src/type-aware-decision";
import { makeRegistryValidator } from "../src/registry-validator";
import { SemanticIndex } from "../src/semantic-index";
import { MockEmbeddingPort } from "../src/embedding-port";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { makeToolset, type ToolsetBinding } from "../src/toolset";
import { serializeArtifact, restoreArtifact, MemoryStorage } from "../src/storage";
import { Replay } from "../src/replay";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function buildSite() {
  const registry = new TypeRegistry();
  registry.register("PageContent", {
    decompose: "opaque",
    validate: (v) => {
      const o = v as { title?: unknown };
      if (typeof v !== "object" || v === null || typeof o.title !== "string") {
        throw new Error("PageContent requires a string title");
      }
    },
    embedText: (v) => {
      const o = v as { title?: string; body?: string };
      return `${o.title ?? ""} ${o.body ?? ""}`.trim();
    },
  });

  const clock = new FixedClock(0);
  const deps: TreeDeps = {
    idGen: new SeqIdGen(),
    clock,
    decision: typeAwareDecision(sizeBasedDecision(1), registry),
  };
  const tree = ArtifactTree.fromJson({ site: { pages: {} }, brandFacts: {} }, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const embedding = new MockEmbeddingPort();
  const vectors = new MemoryVectorIndex();
  const index = new SemanticIndex(tree, addressing, embedding, vectors, registry);
  const mutator = new Mutator(tree, addressing, log, {
    clock,
    validate: makeRegistryValidator(registry),
    ...index.hooks(),
  });

  // Admin seeds brand facts (plain tagged string leaves).
  mutator.insert({ path: "/brandFacts" }, "price", "2990", { tags: ["brand-fact"] });
  mutator.insert({ path: "/brandFacts" }, "tagline", "Fast and simple", { tags: ["brand-fact"] });

  // Planner scaffolds typed, tagged page stubs (one opaque PageContent leaf each).
  for (const slug of ["home", "pricing", "about"]) {
    const title = slug[0].toUpperCase() + slug.slice(1);
    mutator.insert(
      { path: "/site/pages" },
      slug,
      { title, body: "" },
      { type: "PageContent", tags: ["page", `slug:${slug}`] },
    );
  }

  const tools = (binding: ToolsetBinding) => makeToolset({ tree, addressing, log, mutator, index }, binding);
  return { registry, clock, tree, addressing, log, embedding, vectors, index, mutator, tools };
}

describe("M9 content-site scenario (full stack)", () => {
  it("scoped writers fill pages; an editor finds the right page by meaning and lists pages by tag", async () => {
    const w = buildSite();

    const pricer = w.tools({ owner: "writer:pricing", writeScope: "/site/pages/pricing" });
    const facts = await pricer.find({ tag: "brand-fact" });
    expect(facts.ok).toBe(true);
    if (facts.ok) expect(facts.value.hits.length).toBe(2);
    expect(
      (await pricer.patch({ path: "/site/pages/pricing" }, { op: "set", value: { title: "Pricing", body: "plans and cost" } })).ok,
    ).toBe(true);

    const homer = w.tools({ owner: "writer:home", writeScope: "/site/pages/home" });
    expect(
      (await homer.patch({ path: "/site/pages/home" }, { op: "set", value: { title: "Home", body: "welcome here" } })).ok,
    ).toBe(true);

    await w.index.reindex();

    const editor = w.tools({ readScope: "/site" });
    const found = await editor.search("Pricing plans and cost");
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.value.results[0].path).toBe("/site/pages/pricing");

    const pages = await editor.find({ tag: "page" });
    expect(pages.ok).toBe(true);
    if (pages.ok) {
      expect(pages.value.hits.map((h) => h.path).sort()).toEqual([
        "/site/pages/about",
        "/site/pages/home",
        "/site/pages/pricing",
      ]);
    }
  });

  it("a writer scoped to its page cannot edit a sibling page or brand facts", async () => {
    const w = buildSite();
    const pricer = w.tools({ owner: "writer:pricing", writeScope: "/site/pages/pricing" });

    const sibling = await pricer.patch({ path: "/site/pages/home" }, { op: "set", value: { title: "Home", body: "hijacked" } });
    expect(sibling.ok).toBe(false);
    if (!sibling.ok) expect(sibling.error.code).toBe("SCOPE_VIOLATION");

    const fact = await pricer.patch({ path: "/brandFacts/price" }, { op: "set", value: "0" });
    expect(fact.ok).toBe(false);

    const own = await pricer.patch({ path: "/site/pages/pricing" }, { op: "set", value: { title: "Pricing", body: "ok" } });
    expect(own.ok).toBe(true);
  });

  it("type validation rejects a page missing its title and leaves the page unchanged", async () => {
    const w = buildSite();
    const pricer = w.tools({ writeScope: "/site/pages/pricing" });

    const bad = await pricer.patch({ path: "/site/pages/pricing" }, { op: "set", value: { body: "no title" } });
    expect(bad.ok).toBe(false);

    const got = await pricer.get({ path: "/site/pages/pricing" });
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value.content).toEqual({ title: "Pricing", body: "" });
  });

  it("the whole site persists and restores with semantic search intact", async () => {
    const w = buildSite();
    await w
      .tools({ writeScope: "/site/pages/pricing" })
      .patch({ path: "/site/pages/pricing" }, { op: "set", value: { title: "Pricing", body: "plans and cost" } });
    await w.index.reindex();

    const store = new MemoryStorage();
    await store.save(await serializeArtifact(w.tree, w.log, w.vectors));
    const loaded = (await store.load())!;

    const freshDeps: TreeDeps = {
      idGen: new SeqIdGen(),
      clock: new FixedClock(0),
      decision: typeAwareDecision(sizeBasedDecision(1), w.registry),
    };
    const freshVectors = new MemoryVectorIndex();
    const { tree: rtree, log: rlog } = await restoreArtifact(loaded, freshDeps, freshVectors);
    const rindex = new SemanticIndex(rtree, new Addressing(rtree), new MockEmbeddingPort(), freshVectors, w.registry);

    expect(rtree.toJson()).toEqual(w.tree.toJson());
    expect(rlog.entries()).toEqual(w.log.entries());

    const r = await rindex.search("Pricing plans and cost");
    expect(r.results[0].path).toBe("/site/pages/pricing");
  });

  it("time-travel recovers an earlier version of a page", () => {
    const w = buildSite();
    const vScaffold = w.log.length();
    w.mutator.set({ path: "/site/pages/pricing" }, { title: "Pricing", body: "final copy" });

    const replay = new Replay(w.tree, w.log);
    expect(replay.getAt("/site/pages/pricing", vScaffold)).toEqual({ title: "Pricing", body: "" });
    expect(replay.getAt("/site/pages/pricing", w.log.length())).toEqual({ title: "Pricing", body: "final copy" });
  });
});
