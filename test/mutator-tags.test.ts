import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function setup(json: unknown) {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(3) };
  const tree = ArtifactTree.fromJson(json as never, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock });
  return { tree, addressing, log, mutator };
}

describe("Mutator tag assignment", () => {
  it("insert with tags stamps them on the new node", () => {
    const { tree, mutator } = setup({ a: 1 });
    const id = mutator.insert({ path: "" }, "b", 2, { tags: ["x", "y"] });
    expect(tree.get(id)!.tags).toEqual(["x", "y"]);
  });

  it("set with tags stamps them on the node", () => {
    const { addressing, mutator } = setup({ a: 1 });
    mutator.set({ path: "/a" }, 2, { tags: ["t"] });
    expect(addressing.byPath("/a")!.tags).toEqual(["t"]);
  });

  it("leaves existing tags untouched when opts.tags is omitted", () => {
    const { addressing, mutator } = setup({ a: 1 });
    mutator.set({ path: "/a" }, 2, { tags: ["t"] });
    mutator.set({ path: "/a" }, 3);
    expect(addressing.byPath("/a")!.tags).toEqual(["t"]);
  });
});
