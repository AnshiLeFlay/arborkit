import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { serializeArtifact, restoreArtifact } from "../src/storage";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen, type IdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function freshDeps(idGen: IdGen = new SeqIdGen()): TreeDeps {
  return { idGen, clock: new FixedClock(0), decision: sizeBasedDecision(1) };
}

/** A fresh SeqIdGen advanced past the first `n` ids — simulating a restarted
 *  process. We deliberately skip the ROOT/container ids: pre-fix, colliding with
 *  an ANCESTOR of the insertion point corrupts the parent chain into a cycle and
 *  hangs `pathOf` synchronously (not assertable); colliding with a sibling LEAF
 *  clobbers it observably instead. Post-fix both are impossible. */
function advancedSeqIdGen(n: number): IdGen {
  const gen = new SeqIdGen();
  for (let i = 0; i < n; i++) gen.next();
  return gen;
}

describe("restoreArtifact idGen guard", () => {
  it("a fresh deterministic idGen cannot re-mint restored node ids — post-restore mutations stay consistent", async () => {
    // Original process: build with a deterministic SeqIdGen.
    // Ids: n0 = root, n1 = /docs container, n2 = leaf /docs/a.
    const d1 = freshDeps();
    const tree = ArtifactTree.fromJson({ docs: {} }, d1);
    const log = new EventLog();
    const mutator = new Mutator(tree, new Addressing(tree), log, { clock: d1.clock });
    mutator.insert({ path: "/docs" }, "a", "hello");
    const stored = await serializeArtifact(tree, log, new MemoryVectorIndex());

    // New process: restore with a fresh SeqIdGen (advanced to n2 — see helper).
    const d2 = freshDeps(advancedSeqIdGen(2));
    const { tree: rtree, log: rlog } = await restoreArtifact(stored, d2, new MemoryVectorIndex());
    const rmutator = new Mutator(rtree, new Addressing(rtree), rlog, { clock: d2.clock });

    // Pre-fix: this insert minted "n2" — the id of the LIVE leaf /docs/a — and
    // silently replaced that node in the node map ("a" vanishes, "b" doubles).
    rmutator.insert({ path: "/docs" }, "b", "world");
    expect(rtree.toJson()).toEqual({ docs: { a: "hello", b: "world" } });

    // A set that re-decomposes mints more ids — none may collide either.
    rmutator.set({ path: "/docs/a" }, { x: "one", y: "two" });
    expect(rtree.toJson()).toEqual({ docs: { a: { x: "one", y: "two" }, b: "world" } });

    // Structural integrity: unique ids, and every parent chain terminates at the
    // root without cycles (a collision corrupts the chain into a cycle).
    const nodes = rtree.allNodes();
    expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length);
    const rootId = rtree.rootIdValue();
    for (const n of nodes) {
      const seen = new Set<string>();
      let cur = n;
      while (cur.parentId !== null) {
        expect(seen.has(cur.id)).toBe(false);
        seen.add(cur.id);
        const parent = rtree.get(cur.parentId);
        expect(parent).toBeDefined();
        cur = parent!;
      }
      expect(cur.id).toBe(rootId);
    }
  });

  it("the guard stays on the returned tree — every later mutation keeps skipping live ids", async () => {
    // Ids: n0 = root, n1 = /list container, n2 = leaf x, n3 = leaf y.
    const d1 = freshDeps();
    const tree = ArtifactTree.fromJson({ list: {} }, d1);
    const log = new EventLog();
    const mutator = new Mutator(tree, new Addressing(tree), log, { clock: d1.clock });
    mutator.insert({ path: "/list" }, "x", "one");
    mutator.insert({ path: "/list" }, "y", "two");
    const stored = await serializeArtifact(tree, log, new MemoryVectorIndex());

    const { tree: rtree, log: rlog } = await restoreArtifact(
      stored,
      freshDeps(advancedSeqIdGen(2)),
      new MemoryVectorIndex(),
    );
    const rmutator = new Mutator(rtree, new Addressing(rtree), rlog, { clock: new FixedClock(0) });
    // Several sequential mutations: each mint must skip ALL live ids — the
    // restored ones AND the ones minted since the restore.
    rmutator.insert({ path: "/list" }, "z", "three"); // pre-fix: minted n2, clobbering leaf x
    rmutator.insert({ path: "/list" }, "w", "four"); // pre-fix: minted n3, clobbering leaf y
    rmutator.set({ path: "/list/x" }, "one!");
    expect(rtree.toJson()).toEqual({ list: { x: "one!", y: "two", z: "three", w: "four" } });
    const nodes = rtree.allNodes();
    expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length);
  });
});
