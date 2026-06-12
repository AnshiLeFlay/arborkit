import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { SemanticIndex } from "../src/semantic-index";
import { MockEmbeddingPort } from "../src/embedding-port";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { serializeArtifact, restoreArtifact, MemoryStorage } from "../src/storage";
import { StaleVersionError } from "../src/errors";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function freshDeps(): TreeDeps {
  return { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
}

describe("M10 capstone: the index survives decomposition, restore, and failed transactions", () => {
  it("end-to-end", async () => {
    const tree = ArtifactTree.fromJson({ docs: {} }, freshDeps());
    const addressing = new Addressing(tree);
    const log = new EventLog();
    const vectors = new MemoryVectorIndex();
    const index = new SemanticIndex(tree, addressing, new MockEmbeddingPort(), vectors);
    const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0), ...index.hooks() });

    // decomposed children are queued (C1)
    mutator.insert({ path: "/docs" }, "page", { title: "alpha beta", body: "gamma delta" });
    const staleAfterInsert = index.staleCount();
    expect(staleAfterInsert).toBeGreaterThanOrEqual(2);

    // a failed transaction adds nothing to the queue (C3)
    expect(() =>
      mutator.transaction(() => {
        mutator.insert({ path: "/docs" }, "doomed", "ghost text");
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(index.staleCount()).toBe(staleAfterInsert);

    // persist while stale → restore → still searchable after reindex (C2)
    const store = new MemoryStorage();
    await store.save(serializeArtifact(tree, log, vectors));
    const loaded = (await store.load())!;
    const freshVectors = new MemoryVectorIndex();
    const { tree: rtree } = restoreArtifact(loaded, freshDeps(), freshVectors);
    const rindex = new SemanticIndex(rtree, new Addressing(rtree), new MockEmbeddingPort(), freshVectors);
    expect(rindex.staleCount()).toBe(staleAfterInsert);
    await rindex.reindex();
    const r = await rindex.search("alpha beta");
    expect(r.results.some((h) => h.path === "/docs/page/title")).toBe(true);
  });
});

describe("M10: ifVersion-on-insert semantics are parent-scoped (pinned + documented)", () => {
  it("two concurrent-style inserts with the same parent ifVersion: second is rejected", () => {
    const tree = ArtifactTree.fromJson({ docs: {} }, freshDeps());
    const addressing = new Addressing(tree);
    const mutator = new Mutator(tree, addressing, new EventLog(), { clock: new FixedClock(0) });
    const parentV = addressing.byPath("/docs")!.meta.version;
    mutator.insert({ path: "/docs" }, "a", "1", { ifVersion: parentV }); // CAS on the container: ok, bumps parent
    expect(() => mutator.insert({ path: "/docs" }, "b", "2", { ifVersion: parentV })).toThrow(StaleVersionError);
  });
});
