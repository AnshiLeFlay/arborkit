import { describe, it, expect } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { SemanticIndex } from "../src/semantic-index";
import { MockEmbeddingPort } from "../src/embedding-port";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { serializeArtifact, restoreArtifact, MemoryStorage } from "../src/storage";
import { FileStorage } from "../src/file-storage";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function buildAndIndex() {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson({ docs: {} }, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const vectors = new MemoryVectorIndex();
  const index = new SemanticIndex(tree, addressing, new MockEmbeddingPort(), vectors);
  const mutator = new Mutator(tree, addressing, log, { clock, ...index.hooks() });
  return { tree, log, vectors, index, mutator };
}

function freshDeps(): TreeDeps {
  return { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
}

describe("M6 storage round-trip", () => {
  it("MemoryStorage: restores tree+events+vectors so semantic search works without reindexing", async () => {
    const orig = buildAndIndex();
    orig.mutator.insert({ path: "/docs" }, "a", "the quick brown fox");
    orig.mutator.insert({ path: "/docs" }, "b", "lorem ipsum");
    await orig.index.reindex();

    const store = new MemoryStorage();
    await store.save(serializeArtifact(orig.tree, orig.log, orig.vectors));
    const loaded = (await store.load())!;

    const freshVectors = new MemoryVectorIndex();
    const { tree: rtree, log: rlog } = restoreArtifact(loaded, freshDeps(), freshVectors);
    const rindex = new SemanticIndex(rtree, new Addressing(rtree), new MockEmbeddingPort(), freshVectors);

    expect(rtree.toJson()).toEqual(orig.tree.toJson());
    expect(rlog.entries()).toEqual(orig.log.entries());

    const r = await rindex.search("the quick brown fox");
    expect(r.results[0].path).toBe("/docs/a");
    expect(r.staleCount).toBe(0);
  });

  it("FileStorage: round-trips the same bundle through a JSON file", async () => {
    const orig = buildAndIndex();
    orig.mutator.insert({ path: "/docs" }, "a", "hello world");
    await orig.index.reindex();
    const path = join(tmpdir(), "arbor-m6-capstone.test.json");
    const store = new FileStorage(path);
    try {
      await store.save(serializeArtifact(orig.tree, orig.log, orig.vectors));
      const loaded = (await store.load())!;
      const freshVectors = new MemoryVectorIndex();
      const { tree: rtree } = restoreArtifact(loaded, freshDeps(), freshVectors);
      expect(rtree.toJson()).toEqual(orig.tree.toJson());
      expect(freshVectors.size()).toBe(orig.vectors.size());
    } finally {
      await rm(path, { force: true });
    }
  });
});
