import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";
import type { Json } from "../src/types";
import { getAtPath, setAtPathMut, insertAtPathMut, removeAtPathMut } from "../src/json-edit";
import { toJsonPatch, snapshotEvent, deltaSince, type JsonPatchOp } from "../src/ag-ui";
import { InvalidOpError } from "../src/errors";

function setup(json: unknown) {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson(json as never, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock });
  return { tree, addressing, log, mutator };
}

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

describe("AG-UI adapter", () => {
  it("toJsonPatch maps all four event kinds to RFC 6902 ops", () => {
    const { mutator, log } = setup({ a: "x", b: "y", list: [1, 2], from: { x: "v" }, to: {} });
    mutator.set({ path: "/a" }, "z");
    mutator.insert({ path: "/list" }, 1, 99);
    mutator.remove({ path: "/b" });
    mutator.move({ path: "/from/x" }, { path: "/to" }, "x");

    const ops = log.entries().map((e) => toJsonPatch(e));
    expect(ops[0]).toEqual({ op: "replace", path: "/a", value: "z" });
    expect(ops[1]).toEqual({ op: "add", path: "/list/1", value: 99 });
    expect(ops[2]).toEqual({ op: "remove", path: "/b" });
    expect(ops[3]).toEqual({ op: "move", from: "/from/x", path: "/to/x" });
  });

  it("snapshot at version A + deltaSince(A) applied client-side equals the live tree", () => {
    const { tree, log, mutator } = setup({ docs: { a: "one" }, list: ["x"] });
    mutator.insert({ path: "/docs" }, "b", "two");

    const versionA = log.length();
    const snap = snapshotEvent(tree);
    expect(snap.type).toBe("STATE_SNAPSHOT");

    // History past A: array inserts that shift indices, a set, a move, a remove.
    mutator.insert({ path: "/list" }, 0, "first"); // shifts "x" to index 1
    mutator.insert({ path: "/list" }, 2, "last");
    mutator.set({ path: "/docs/a" }, "ONE");
    mutator.move({ path: "/docs/b" }, { path: "/list" }, 1); // into the array mid-list
    mutator.remove({ path: "/list/0" });

    const { event, nextSeq } = deltaSince(log, versionA);
    expect(event.type).toBe("STATE_DELTA");
    expect(nextSeq).toBe(log.length());

    const result = applyOps(snap.snapshot, event.delta);
    expect(result).toEqual(tree.toJson());
  });

  it("pathless (pre-M7) events map to null and are skipped by deltaSince", () => {
    const { mutator, log } = setup({ a: "x" });
    mutator.set({ path: "/a" }, "y");
    delete (log.at(0) as { path?: string }).path;

    expect(toJsonPatch(log.at(0)!)).toBeNull();
    const { event } = deltaSince(log, 0);
    expect(event.delta).toEqual([]);
  });

  it("deltaSince throws below the compaction floor instead of silently dropping ops", () => {
    const { mutator, log } = setup({ a: "x", b: "y", c: "z" });
    mutator.set({ path: "/a" }, "1");
    mutator.set({ path: "/b" }, "2");
    mutator.set({ path: "/c" }, "3");
    log.compactTo(2);
    expect(() => deltaSince(log, 0)).toThrow(InvalidOpError); // pre-fix: returns a gapped delta
    expect(deltaSince(log, 2).event.delta.length).toBeGreaterThanOrEqual(0); // at the floor is fine
  });
});
