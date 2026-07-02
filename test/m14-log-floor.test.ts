import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { InvalidOpError } from "../src/errors";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function setup() {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson({ docs: {} }, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0) });
  return { tree, addressing, log, mutator };
}

describe("M14 log floor discipline", () => {
  it("rollback after an in-transaction compactTo fails LOUDLY (versions cannot silently diverge)", () => {
    const s = setup();
    s.mutator.insert({ path: "/docs" }, "a", "1"); // seq 0
    s.mutator.set({ path: "/docs/a" }, "2"); // seq 1
    expect(() =>
      s.mutator.transaction(() => {
        s.mutator.set({ path: "/docs/a" }, "3"); // seq 2
        s.log.compactTo(3); // compaction INSIDE a tx — burns seqs 0-2
        throw new Error("boom"); // rollback wants truncateTo(2), below floor 3
      }),
    ).toThrow(InvalidOpError); // pre-fix: silent — log.length()=3 with a seq-2 tree
  });

  it("truncateTo at/above the floor still works (rollback across a compacted log)", () => {
    const log = new EventLog();
    const ev = { kind: "set" as const, targetId: "n1", parentId: "n0", key: "k", ts: 0 };
    for (let i = 0; i < 5; i++) log.append(ev);
    log.compactTo(2);
    log.truncateTo(3);
    expect(log.entries().map((e) => e.seq)).toEqual([2]);
    expect(log.length()).toBe(3);
  });
});
