import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { SemanticIndex } from "../src/semantic-index";
import { MockEmbeddingPort } from "../src/embedding-port";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function setup(json: unknown) {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson(json as never, deps);
  const addressing = new Addressing(tree);
  const vectors = new MemoryVectorIndex();
  const index = new SemanticIndex(tree, addressing, new MockEmbeddingPort(), vectors);
  return { tree, addressing, vectors, index };
}

describe("SemanticIndex lifecycle", () => {
  it("onChange marks an embeddable leaf stale and enqueues it", () => {
    const { addressing, index } = setup({ t: "hello world" });
    const node = addressing.byPath("/t")!;
    index.onChange(node);
    expect(node.meta.embedding.state).toBe("stale");
    expect(index.staleCount()).toBe(1);
  });

  it("onChange marks a non-embeddable node 'none' and does not enqueue", () => {
    const { addressing, index } = setup({ n: 42 });
    const node = addressing.byPath("/n")!;
    index.onChange(node);
    expect(node.meta.embedding.state).toBe("none");
    expect(index.staleCount()).toBe(0);
  });

  it("reindex embeds stale nodes, upserts vectors, marks them fresh, and clears the queue", async () => {
    const { addressing, vectors, index } = setup({ t: "hello world" });
    const node = addressing.byPath("/t")!;
    index.onChange(node);
    await index.reindex();
    expect(node.meta.embedding.state).toBe("fresh");
    expect(await vectors.has(node.id)).toBe(true);
    expect(index.staleCount()).toBe(0);
  });

  it("textHash dedupe: onChange on a node whose embedding-text is unchanged is a no-op", async () => {
    const { addressing, index } = setup({ t: "hello" });
    const node = addressing.byPath("/t")!;
    index.onChange(node);
    await index.reindex();
    index.onChange(node);
    expect(node.meta.embedding.state).toBe("fresh");
    expect(index.staleCount()).toBe(0);
  });

  it("onRemove drops the node from the vector index and the stale queue", async () => {
    const { addressing, vectors, index } = setup({ t: "hello" });
    const node = addressing.byPath("/t")!;
    const id = node.id;
    index.onChange(node);
    await index.reindex();
    index.onRemove(id);
    // Removal is deferred to the next reindex() call (tx-safe deferred-removal contract).
    await index.reindex();
    expect(await vectors.has(id)).toBe(false);
    expect(index.staleCount()).toBe(0);
  });

  it("hooks() returns onChange/onRemove bound to the index", () => {
    const { addressing, index } = setup({ t: "hi" });
    const h = index.hooks();
    h.onChange(addressing.byPath("/t")!);
    expect(index.staleCount()).toBe(1);
  });
});
