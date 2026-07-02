import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { serializeArtifact, restoreArtifact, MemoryStorage } from "../src/storage";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

async function build() {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson({ docs: {} }, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock });
  const aId = mutator.insert({ path: "/docs" }, "a", "hello");
  const vectors = new MemoryVectorIndex();
  await vectors.upsert([{ nodeId: aId, vector: [1, 2, 3] }]);
  return { tree, log, vectors, aId };
}

function freshDeps(): TreeDeps {
  return { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
}

describe("serializeArtifact", () => {
  it("dumps the live components into a versioned StoredArtifact", async () => {
    const { tree, log, vectors } = await build();
    const s = await serializeArtifact(tree, log, vectors);
    expect(s.version).toBe(2);
    expect(s.rootId).toBe(tree.rootIdValue());
    expect(s.nodes.length).toBe(tree.size());
    expect(s.events.length).toBe(log.length());
    expect(s.vectors.length).toBe(1);
  });
});

describe("MemoryStorage + restoreArtifact", () => {
  it("load returns null before any save", async () => {
    expect(await new MemoryStorage().load()).toBeNull();
  });

  it("round-trips and restores identical tree, events, and vectors", async () => {
    const { tree, log, vectors, aId } = await build();
    const store = new MemoryStorage();
    await store.save(await serializeArtifact(tree, log, vectors));
    const loaded = (await store.load())!;
    const freshVectors = new MemoryVectorIndex();
    const { tree: rtree, log: rlog } = await restoreArtifact(loaded, freshDeps(), freshVectors);
    expect(rtree.toJson()).toEqual(tree.toJson());
    expect(rlog.entries()).toEqual(log.entries());
    expect(await freshVectors.has(aId)).toBe(true);
    expect(rtree.get(aId)!.content).toBe("hello");
  });

  it("the saved bundle is independent of later mutations to the live components", async () => {
    const { tree, log, vectors } = await build();
    const store = new MemoryStorage();
    await store.save(await serializeArtifact(tree, log, vectors));
    await vectors.upsert([{ nodeId: "later", vector: [9, 9, 9] }]);
    const loaded = (await store.load())!;
    expect(loaded.vectors.length).toBe(1);
  });
});
