import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { Replay } from "../src/replay";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function setup() {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson({ a: null, b: {} }, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0) });
  return { tree, addressing, log, mutator };
}

describe("M14 revert restores type and tags across moves", () => {
  it("restores the type when the path was vacated by a move and re-occupied by an insert", () => {
    const s = setup();
    s.mutator.set({ path: "/a" }, "typed-value", { type: "T" }); // seq 0
    s.mutator.move({ path: "/a" }, { path: "/b" }, "moved"); // seq 1 — vacates /a
    s.mutator.insert({ path: "" }, "a", "new-untyped"); // seq 2 — re-occupies /a
    const replay = new Replay(s.tree, s.log);
    replay.revert(s.mutator, s.addressing, { path: "/a" }, 1); // back to post-seq-0 state
    const node = s.addressing.byPath("/a")!;
    expect(s.tree.toJson(node.id)).toBe("typed-value");
    expect(node.type).toBe("T"); // pre-fix: undefined (typeAt trusted the later insert)
  });

  it("restores tags as of the target version", () => {
    const s = setup();
    s.mutator.set({ path: "/a" }, "v1", { tags: ["x"] }); // seq 0
    s.mutator.set({ path: "/a" }, "v2", { tags: ["y"] }); // seq 1
    const replay = new Replay(s.tree, s.log);
    replay.revert(s.mutator, s.addressing, { path: "/a" }, 1); // state after seq 0
    expect(s.addressing.byPath("/a")!.tags).toEqual(["x"]);
  });

  it("pre-M14 events (no tags fields) leave the current tags untouched on revert", () => {
    const s = setup();
    s.mutator.set({ path: "/a" }, "v1"); // seq 0
    s.mutator.set({ path: "/a" }, "v2", { tags: ["keep-me"] }); // seq 1
    // Simulate a pre-M14 seq-1 event: strip the recorded tag fields.
    delete (s.log.at(1) as { tagsBefore?: string[] }).tagsBefore;
    const replay = new Replay(s.tree, s.log);
    replay.revert(s.mutator, s.addressing, { path: "/a" }, 1); // value → v1
    expect(s.tree.toJson(s.addressing.byPath("/a")!.id)).toBe("v1");
    expect(s.addressing.byPath("/a")!.tags).toEqual(["keep-me"]); // unknown history → keep
  });
});
