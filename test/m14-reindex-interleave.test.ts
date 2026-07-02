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
    expect(s.vectors.has(keepId)).toBe(true); // survivor indexed
    await s.index.reindex(); // drain pendingRemoval
    expect(s.vectors.size()).toBe(1); // no resurrected vector for the removed node
  });
});
