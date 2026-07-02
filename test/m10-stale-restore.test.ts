import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { SemanticIndex } from "../src/semantic-index";
import { MockEmbeddingPort } from "../src/embedding-port";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { serializeArtifact, restoreArtifact, MemoryStorage } from "../src/storage";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function freshDeps(): TreeDeps {
  return { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
}

describe("M10 C2: stale state survives persist→restore", () => {
  it("a node persisted while stale is re-queued and searchable after restore + reindex", async () => {
    const tree = ArtifactTree.fromJson({ docs: {} }, freshDeps());
    const addressing = new Addressing(tree);
    const log = new EventLog();
    const vectors = new MemoryVectorIndex();
    const index = new SemanticIndex(tree, addressing, new MockEmbeddingPort(), vectors);
    const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0), ...index.hooks() });

    mutator.insert({ path: "/docs" }, "a", "the quick brown fox");
    expect(index.staleCount()).toBe(1); // stale, NOT reindexed — the normal mid-run state

    const store = new MemoryStorage();
    await store.save(await serializeArtifact(tree, log, vectors)); // persisted while stale

    const loaded = (await store.load())!;
    const freshVectors = new MemoryVectorIndex();
    const { tree: rtree } = await restoreArtifact(loaded, freshDeps(), freshVectors);
    const rindex = new SemanticIndex(rtree, new Addressing(rtree), new MockEmbeddingPort(), freshVectors);

    expect(rindex.staleCount()).toBe(1); // FIX: seeded from meta.embedding.state
    await rindex.reindex();
    const r = await rindex.search("the quick brown fox");
    expect(r.results[0]?.path).toBe("/docs/a");
    expect(r.staleCount).toBe(0);
  });

  it("a fresh (non-restored) tree seeds nothing", () => {
    const tree = ArtifactTree.fromJson({ a: "x" }, freshDeps());
    const index = new SemanticIndex(tree, new Addressing(tree), new MockEmbeddingPort(), new MemoryVectorIndex());
    expect(index.staleCount()).toBe(0);
  });
});
