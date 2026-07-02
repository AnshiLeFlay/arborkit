import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { SemanticIndex } from "../src/semantic-index";
import { MemoryVectorIndex } from "../src/vector-index-port";
import type { EmbeddingPort } from "../src/embedding-port";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";
import type { Json } from "../src/types";
import { MemoryDeltaStorage } from "../src/delta-storage";
import { persistCheckpoint, persistDelta, restoreFromDelta } from "../src/delta";

/** Embedder whose FIRST batch blocks until gate() is called — lets a test land
 *  mutations "during" the embed await. */
class GatedEmbedder implements EmbeddingPort {
  readonly dims = 2;
  gate!: () => void;
  private readonly wait = new Promise<void>((res) => (this.gate = res));
  private calls = 0;
  async embed(texts: string[]): Promise<number[][]> {
    this.calls += 1;
    if (this.calls === 1) await this.wait;
    return texts.map((t) => [t.length, 1]);
  }
}

function setup(initial: Json, embedder: EmbeddingPort) {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson(initial, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const vectors = new MemoryVectorIndex();
  const index = new SemanticIndex(tree, addressing, embedder, vectors);
  const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0), ...index.hooks() });
  return { tree, addressing, log, mutator, index, vectors };
}

describe("M14 reindex interleaving", () => {
  it("a node changed during the embed await stays stale; the next pass embeds the new text", async () => {
    const embedder = new GatedEmbedder();
    const s = setup({ a: null }, embedder);
    s.mutator.set({ path: "/a" }, "v1-text"); // stale with the v1 hash
    const p = s.index.reindex(); // suspends inside embed (first batch is gated)
    s.mutator.set({ path: "/a" }, "v2-CHANGED-DURING-EMBED"); // re-marks stale, new hash
    embedder.gate();
    await p;
    const node = s.addressing.byPath("/a")!;
    expect(node.meta.embedding.state).toBe("stale"); // NOT falsely fresh (pre-fix: fresh with the v1 hash)
    expect(s.index.staleCount()).toBe(1); // still queued (pre-fix: 0, permanently lost)
    await s.index.reindex(); // second pass embeds v2
    expect(node.meta.embedding.state).toBe("fresh");
    expect(s.index.staleCount()).toBe(0);
  });

  it("a node removed during the embed await neither crashes reindex nor resurrects a vector", async () => {
    const embedder = new GatedEmbedder();
    const s = setup({ a: null, keep: null }, embedder);
    s.mutator.set({ path: "/a" }, "doomed-text");
    s.mutator.set({ path: "/keep" }, "kept-text");
    const keepId = s.addressing.byPath("/keep")!.id;
    const p = s.index.reindex();
    s.mutator.remove({ path: "/a" }); // vanishes mid-flight
    embedder.gate();
    await expect(p).resolves.toBeUndefined(); // pre-fix: TypeError reading 'meta'
    expect(await s.vectors.has(keepId)).toBe(true); // survivor indexed
    await s.index.reindex(); // drain pendingRemoval
    expect(await s.vectors.size()).toBe(1); // no resurrected vector for the removed node
  });

  it("a node whose text becomes null during the embed await is not marked falsely fresh", async () => {
    const embedder = new GatedEmbedder();
    const s = setup({ a: null }, embedder);
    s.mutator.set({ path: "/a" }, "string-text"); // string leaf → embeddable → stale
    const p = s.index.reindex(); // suspends inside embed
    s.mutator.set({ path: "/a" }, 42); // number leaf → embedding text null → state "none", removal queued
    embedder.gate();
    await p;
    const node = s.addressing.byPath("/a")!;
    expect(node.meta.embedding.state).toBe("none"); // pre-fix: "fresh" with the OLD text's hash
    await s.index.reindex(); // drain the queued removal
    expect(await s.vectors.has(node.id)).toBe(false);
    // the forever-miss case: the same text returns → must be re-marked stale, not skipped
    s.mutator.set({ path: "/a" }, "string-text");
    expect(node.meta.embedding.state).toBe("stale");
  });

  it("delta-restored stale nodes (no textHash) are embedded, marked fresh, and searchable", async () => {
    // Build a run, checkpoint it, journal one edit, restore — the touched node
    // comes back { state: "stale" } WITHOUT a textHash (restoreFromDelta's hook).
    const src = setup({ docs: {} }, new GatedEmbedder());
    const store = new MemoryDeltaStorage();
    const hw = await persistCheckpoint(store, src.tree, src.log, src.vectors);
    src.mutator.set({ path: "/docs" }, { a: "restored-text" });
    await persistDelta(store, src.log, hw);

    const deps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
    const vectors = new MemoryVectorIndex();
    const r = (await restoreFromDelta(store, deps, vectors))!;
    const addressing = new Addressing(r.tree);
    const embedder = new GatedEmbedder();
    embedder.gate(); // don't block — gate the (unused) first batch immediately
    const index = new SemanticIndex(r.tree, addressing, embedder, vectors);

    expect(index.staleCount()).toBeGreaterThan(0); // restore seeded the stale queue
    await index.reindex();
    expect(index.staleCount()).toBe(0); // pre-fix: never drains
    const leaf = addressing.byPath("/docs/a")!;
    expect(leaf.meta.embedding.state).toBe("fresh"); // pre-fix: stuck "stale" forever
    expect(await vectors.has(leaf.id)).toBe(true);
  });
});
