import { describe, it, expect } from "vitest";
import { createArbor, restoreArbor } from "../src/arbor";
import { MockEmbeddingPort } from "../src/embedding-port";
import { MemoryDeltaStorage } from "../src/delta-storage";
import { TypeRegistry } from "../src/type-registry";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";
import { sizeBasedDecision } from "../src/decompose";
import { snapshotEvent, deltaSince, type JsonPatchOp } from "../src/ag-ui";
import { getAtPath, setAtPathMut, insertAtPathMut, removeAtPathMut } from "../src/json-edit";
import type { Json } from "../src/types";

/** The typed unit's embed text derives from its WHOLE subtree (mirrors m17-ancestor-staleness). */
const embedText = (v: Json): string => JSON.stringify(v);

/** Apply RFC 6902 ops the way an AG-UI client would (move = remove@from + add@path). */
function applyOps(state: Json, ops: JsonPatchOp[]): Json {
  let cur = state;
  for (const op of ops) {
    if (op.op === "move") {
      const moved = getAtPath(cur, op.from) ?? null;
      cur = removeAtPathMut(cur, op.from);
      cur = insertAtPathMut(cur, op.path, moved);
    } else if (op.op === "replace") cur = setAtPathMut(cur, op.path, op.value);
    else if (op.op === "add") cur = insertAtPathMut(cur, op.path, op.value);
    else cur = removeAtPathMut(cur, op.path);
  }
  return cur;
}

describe("M17 capstone: semantic integrity + AG-UI round-trip through the facade", () => {
  it("shard patch staleness → moves → AG-UI delta round-trip → checkpoint/restore → replay", async () => {
    const registry = new TypeRegistry();
    registry.register("doc", { embedText, decompose: "children" });
    const delta = new MemoryDeltaStorage();
    const mk = () => ({
      idGen: new SeqIdGen(),
      clock: new FixedClock(0),
      decompose: sizeBasedDecision(1),
      registry,
      embedding: new MockEmbeddingPort(),
      delta,
    });

    // --- create. fromJson cannot type nodes (types are applied via mutator opts),
    // so the typed doc is inserted through the mutator instead of `initial`.
    const arbor = createArbor({ ...mk(), initial: { docs: {}, archive: {} } });
    arbor.mutator.insert(
      { path: "/docs" },
      "a",
      { title: "old alpha title", body: "beta body" },
      { type: "doc" },
    ); // seq 0

    // --- reindex → search finds the doc by its embedText.
    await arbor.index!.reindex();
    const found1 = await arbor.index!.search(embedText({ title: "old alpha title", body: "beta body" }));
    expect(found1.results[0]!.path).toBe("/docs/a");
    expect(found1.staleCount).toBe(0);

    // --- SHARD PATCH through a scoped toolset: the typed ancestor is re-marked stale (Task 1).
    const writer = arbor.toolset({ owner: "writer", writeScope: "/docs", readScope: "/docs" });
    const patched = await writer.patch({ path: "/docs/a/title" }, { op: "set", value: "brand new gamma title" }); // seq 1
    expect(patched.ok).toBe(true);
    const doc = arbor.addressing.byPath("/docs/a")!;
    expect(doc.meta.embedding.state).toBe("stale");
    expect(arbor.index!.staleCount()).toBeGreaterThan(0);

    await arbor.index!.reindex();
    const found2 = await arbor.index!.search(embedText({ title: "brand new gamma title", body: "beta body" }));
    expect(found2.results[0]!.path).toBe("/docs/a");

    // --- AG-UI snapshot at version A (Task 6).
    const versionA = arbor.log.length();
    expect(versionA).toBe(2);
    const snap = snapshotEvent(arbor.tree);
    expect(snap.type).toBe("STATE_SNAPSHOT");

    // --- continue mutating: all four op kinds land after A.
    arbor.mutator.insert({ path: "/archive" }, "note", "temporary note"); // seq 2 (add)
    arbor.mutator.move({ path: "/docs/a" }, { path: "/archive" }, "a"); // seq 3 (move)
    // The doc's own embed text is value-derived and unchanged, so the move correctly
    // does NOT re-embed it — its vector stays valid, only its path changed.
    expect(doc.meta.embedding.state).toBe("fresh");

    // A move INTO the typed subtree re-marks the unit stale (Task 1 move hooks):
    // the note becomes a suppressed shard and the doc's subtree grew.
    arbor.mutator.move({ path: "/archive/note" }, { path: "/archive/a" }, "note"); // seq 4 (move)
    const note = arbor.addressing.byPath("/archive/a/note")!;
    expect(note.meta.embedding.state).toBe("none");
    expect(doc.meta.embedding.state).toBe("stale");
    expect(arbor.index!.staleCount()).toBeGreaterThan(0);

    // Shard set at the NEW path still propagates to the moved doc (Task 1 across moves).
    arbor.mutator.set({ path: "/archive/a/body" }, "updated delta body"); // seq 5 (replace)
    expect(doc.meta.embedding.state).toBe("stale");
    arbor.mutator.remove({ path: "/archive/a/note" }); // seq 6 (remove)

    // --- ROUND-TRIP: snapshot + deltaSince(A) applied client-side equals the live tree (Task 6).
    const { event, nextSeq } = deltaSince(arbor.log, versionA);
    expect(event.type).toBe("STATE_DELTA");
    expect(event.delta.map((op) => op.op)).toEqual(["add", "move", "move", "replace", "remove"]);
    expect(nextSeq).toBe(arbor.log.length());
    expect(applyOps(snap.snapshot, event.delta)).toEqual(arbor.tree.toJson());

    // --- reindex → search reflects the moves + edit at the NEW path.
    await arbor.index!.reindex();
    const newText = embedText({ title: "brand new gamma title", body: "updated delta body" });
    const found3 = await arbor.index!.search(newText);
    expect(found3.results[0]!.path).toBe("/archive/a");
    expect(found3.staleCount).toBe(0);

    // --- checkpoint with log compaction, then restore (Tasks 2-5 under the hood).
    await arbor.checkpoint({ keepLast: 5 }); // 7 events → compaction floor 2

    const restored = await restoreArbor(mk());
    expect(restored).not.toBeNull();
    expect(restored!.tree.toJson()).toEqual({
      docs: {},
      archive: { a: { title: "brand new gamma title", body: "updated delta body" } },
    });
    expect(restored!.log.length()).toBe(7);
    expect(restored!.log.baseSeqValue()).toBe(2);

    await restored!.index!.reindex();
    const found4 = await restored!.index!.search(newText);
    expect(found4.results[0]!.path).toBe("/archive/a");
    expect(found4.staleCount).toBe(0);

    // Replay on the restored log: current version, a reverse-applied past version
    // (walks back across remove/set/move/move/insert), and below the compaction floor.
    expect(restored!.replay.getAt("/archive/a", restored!.log.length())).toEqual({
      title: "brand new gamma title",
      body: "updated delta body",
    });
    expect(restored!.replay.getAt("/docs/a/title", versionA)).toBe("brand new gamma title");
    expect(restored!.replay.getAt("/archive/a", versionA)).toBeUndefined(); // not moved yet at A
    expect(() => restored!.replay.getAt("/archive/a", versionA - 1)).toThrow(/compacted/);
  });
});
