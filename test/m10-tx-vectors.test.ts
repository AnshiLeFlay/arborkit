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

function setup() {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson({ docs: {} }, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const vectors = new MemoryVectorIndex();
  const index = new SemanticIndex(tree, addressing, new MockEmbeddingPort(), vectors);
  const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0), ...index.hooks() });
  return { tree, addressing, index, mutator, vectors };
}

describe("M10 tx-vectors: vector mutations deferred to reindex (HOLE 2 fix)", () => {
  it("test 1: onChange-in-tx: rollback preserves vector after set-to-incompatible-type", async () => {
    // Insert a text leaf, reindex so the vector is live.
    const { addressing, index, mutator, vectors } = setup();
    mutator.insert({ path: "/docs" }, "note", "hello world");
    await index.reindex();

    const noteNode = addressing.byPath("/docs/note")!;
    const noteId = noteNode.id;
    // Vector must exist after reindex
    expect(await vectors.has(noteId)).toBe(true);

    // Transaction: set the text leaf to a number (which has null embedding-text for a
    // plain non-typed node on sizeBasedDecision threshold=1, the number IS opaque so
    // it stays at the leaf level — but numbers produce null from toEmbeddingText).
    // Actually for a leaf set to a number, toEmbeddingText returns null → onChange
    // tries to remove the vector.  The tx throws → rollback.  After rollback the
    // vector must still be there and the node still searchable.
    expect(() =>
      mutator.transaction(() => {
        mutator.set({ id: noteId }, 42);
        throw new Error("boom");
      }),
    ).toThrow("boom");

    // The node is back to "hello world" text, so search must find it.
    const r = await index.search("hello world");
    expect(r.results.some((h) => h.path === "/docs/note")).toBe(true);
    // staleCount must be zero — the node was fresh before the tx, rollback restores that.
    expect(index.staleCount()).toBe(0);
  });

  it("test 2: onRemove-in-tx: rollback preserves vector after remove", async () => {
    const { addressing, index, mutator, vectors } = setup();
    mutator.insert({ path: "/docs" }, "note", "persistent text");
    await index.reindex();

    const noteId = addressing.byPath("/docs/note")!.id;
    expect(await vectors.has(noteId)).toBe(true);

    // Transaction removes the node then throws → rollback.
    expect(() =>
      mutator.transaction(() => {
        mutator.remove({ id: noteId });
        throw new Error("boom");
      }),
    ).toThrow("boom");

    // After rollback the node is restored — search must still find it.
    const r = await index.search("persistent text");
    expect(r.results.some((h) => h.path === "/docs/note")).toBe(true);
  });

  it("test 3: deferred removal — best-effort search hides pendingRemoval entries", async () => {
    const { addressing, index, mutator, vectors } = setup();
    mutator.insert({ path: "/docs" }, "note", "unique phrase here");
    await index.reindex();

    const noteNode = addressing.byPath("/docs/note")!;
    const noteId = noteNode.id;
    expect(await vectors.has(noteId)).toBe(true);

    // Outside tx: set to a number — queues pendingRemoval (does NOT remove vector yet).
    mutator.set({ id: noteId }, 42);

    // Immediate best-effort search MUST NOT return the node (pendingRemoval filter).
    const r1 = await index.search("unique phrase here");
    expect(r1.results.some((h) => h.id === noteId)).toBe(false);

    // After reindex, the vector is physically removed.
    await index.reindex();
    expect(await vectors.has(noteId)).toBe(false);
  });

  it("test 4: HOLE 1 / guard-aware reindex: stale shard node is suppressed at reindex time", async () => {
    // Build a registry where Page has embedText (whole-object embed) but no decompose
    // override → sizeBasedDecision(1) still decomposes it into children.
    const registry = new TypeRegistry();
    registry.register("Page", {
      embedText: (v) => String((v as { title?: unknown }).title ?? ""),
    });

    const clock = new FixedClock(0);
    const deps: TreeDeps = {
      idGen: new SeqIdGen(),
      clock,
      decision: typeAwareDecision(sizeBasedDecision(1), registry),
    };
    const tree = ArtifactTree.fromJson({ docs: {} }, deps);
    const addressing = new Addressing(tree);
    const log = new EventLog();
    const vectors1 = new MemoryVectorIndex();
    const index1 = new SemanticIndex(tree, addressing, new MockEmbeddingPort(), vectors1, registry);
    const mutator = new Mutator(tree, addressing, log, { clock, ...index1.hooks() });

    mutator.insert(
      { path: "/docs" },
      "page",
      { title: "alpha", nested: { deep: "shard text" } },
      { type: "Page" },
    );
    await index1.reindex();

    // Find the shard node (grandchild under /docs/page).
    const shardNode = addressing.byPath("/docs/page/nested/deep");
    expect(shardNode).not.toBeNull();
    const shardId = shardNode!.id;

    // Manually corrupt meta to simulate a pre-guard artifact persisted as stale.
    shardNode!.meta.embedding = { state: "stale", textHash: "x" };

    // Build a NEW SemanticIndex over the same tree — constructor seeds stale from meta.
    const vectors2 = new MemoryVectorIndex();
    const index2 = new SemanticIndex(tree, new Addressing(tree), new MockEmbeddingPort(), vectors2, registry);

    // The shard should have been seeded as stale by the constructor.
    // After reindex, the guard must suppress it.
    await index2.reindex();

    // Search for the shard text — should not appear under /docs/page/.
    const r = await index2.search("shard text");
    const shardHits = r.results.filter((h) => h.path.startsWith("/docs/page/"));
    expect(shardHits).toHaveLength(0);

    // The shard node's meta must now be {state:"none"}.
    expect(shardNode!.meta.embedding).toEqual({ state: "none" });
  });

  it("test 5: committed tx removal sticks — vector gone after reindex", async () => {
    const { addressing, index, mutator, vectors } = setup();
    mutator.insert({ path: "/docs" }, "note", "text to remove");
    await index.reindex();

    const noteId = addressing.byPath("/docs/note")!.id;
    expect(await vectors.has(noteId)).toBe(true);

    // Committed transaction: set to 42 (null embedding text → pendingRemoval).
    mutator.transaction(() => {
      mutator.set({ id: noteId }, 42);
    });

    // Before reindex: vector still physically present (deferred), but search hides it.
    const r1 = await index.search("text to remove");
    expect(r1.results.some((h) => h.id === noteId)).toBe(false);

    // After reindex: vector is gone.
    await index.reindex();
    expect(await vectors.has(noteId)).toBe(false);
  });
});
