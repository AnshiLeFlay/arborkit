/**
 * Arbor end-to-end example — a tiny content-generation "site" built and edited by
 * scoped agents over one shared artifact tree. Run with:  npm run example
 *
 * It wires the full stack (typed tree + semantic index + reversible log + scoped
 * toolset + storage + replay) and narrates each step to stdout.
 */
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
import { makeToolset } from "../src/toolset";
import { serializeArtifact, restoreArtifact, MemoryStorage } from "../src/storage";
import { Replay } from "../src/replay";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { SystemClock } from "../src/clock";

// 1. Register a node type: each page is one opaque, typed, embeddable unit.
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

// 2. Build the shared artifact + wire validation, type-aware decomposition, and the index.
//    Threshold 1 keeps empty scaffolds (`{}`) navigable objects rather than opaque leaves.
const vectors = new MemoryVectorIndex();
const deps: TreeDeps = {
  idGen: new SeqIdGen(),
  clock: new SystemClock(),
  decision: typeAwareDecision(sizeBasedDecision(1), registry),
};
const tree = ArtifactTree.fromJson({ site: { pages: {} }, brandFacts: {} }, deps);
const addressing = new Addressing(tree);
const log = new EventLog();
const index = new SemanticIndex(tree, addressing, new MockEmbeddingPort(), vectors, registry);
const mutator = new Mutator(tree, addressing, log, {
  clock: deps.clock,
  validate: makeRegistryValidator(registry),
  ...index.hooks(),
});

// 3. Admin seeds brand facts and scaffolds typed page stubs.
mutator.insert({ path: "/brandFacts" }, "price", "2990", { tags: ["brand-fact"] });
for (const slug of ["home", "pricing", "about"]) {
  const title = slug[0].toUpperCase() + slug.slice(1);
  mutator.insert({ path: "/site/pages" }, slug, { title, body: "" }, { type: "PageContent", tags: ["page", `slug:${slug}`] });
}
const vScaffold = log.length();
console.log("1. scaffolded:", JSON.stringify(tree.toJson()));

// 4. A content-writer agent, scoped to its own page, reads a brand fact then writes.
const pricer = makeToolset({ tree, addressing, log, mutator, index }, { owner: "writer:pricing", writeScope: "/site/pages/pricing" });
const facts = await pricer.find({ tag: "brand-fact" });
console.log("2. pricing writer can read brand facts:", facts.ok && facts.value.map((h) => h.path));
await pricer.patch({ path: "/site/pages/pricing" }, { op: "set", value: { title: "Pricing", body: "plans and cost" } });

// A write outside its scope is refused as a structured error (no throw).
const refused = await pricer.patch({ path: "/site/pages/home" }, { op: "set", value: { title: "Home", body: "nope" } });
console.log("3. cross-page write refused:", refused.ok === false && refused.error.code);

// 5. Reindex, then an editor searches the site by meaning.
await index.reindex();
const editor = makeToolset({ tree, addressing, log, mutator, index }, { readScope: "/site" });
const hit = await editor.search("Pricing plans and cost");
console.log("4. semantic search top hit:", hit.ok && hit.value.results[0]?.path);

// 6. Persist the whole artifact and restore it into fresh components — search still works.
const store = new MemoryStorage();
await store.save(serializeArtifact(tree, log, vectors));
const loaded = (await store.load())!;
const freshVectors = new MemoryVectorIndex();
const restoreDeps: TreeDeps = {
  idGen: new SeqIdGen(),
  clock: new SystemClock(),
  decision: typeAwareDecision(sizeBasedDecision(1), registry),
};
const { tree: rtree } = restoreArtifact(loaded, restoreDeps, freshVectors);
const rindex = new SemanticIndex(rtree, new Addressing(rtree), new MockEmbeddingPort(), freshVectors, registry);
const afterRestore = await rindex.search("Pricing plans and cost");
console.log("5. search after restore:", afterRestore.results[0]?.path);

// 7. Time-travel: read the pricing page as it was right after scaffolding vs now.
const replay = new Replay(tree, log);
console.log("6. pricing page at scaffold:", replay.getAt("/site/pages/pricing", vScaffold));
console.log("7. pricing page now:       ", replay.getAt("/site/pages/pricing", log.length()));
