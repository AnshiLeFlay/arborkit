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
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson(json as never, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock });
  return { tree, addressing, log, mutator };
}

function last(log: EventLog) {
  const e = log.entries();
  return e[e.length - 1];
}

describe("Mutator records event paths", () => {
  it("set records the target's path", () => {
    const { mutator, log } = setup({ a: "x" });
    mutator.set({ path: "/a" }, "y");
    expect(last(log).path).toBe("/a");
  });

  it("insert records the new node's path", () => {
    const { mutator, log } = setup({ docs: {} });
    mutator.insert({ path: "/docs" }, "k", "v");
    expect(last(log).path).toBe("/docs/k");
  });

  it("remove records the removed node's pre-removal path", () => {
    const { mutator, log } = setup({ a: "x", b: "y" });
    mutator.remove({ path: "/b" });
    expect(last(log).path).toBe("/b");
  });

  it("move records fromPath and toPath", () => {
    const { mutator, log, addressing } = setup({ from: { x: "v" }, to: {} });
    const xId = addressing.byPath("/from/x")!.id;
    mutator.move({ id: xId }, { path: "/to" }, "x");
    expect(last(log).fromPath).toBe("/from/x");
    expect(last(log).toPath).toBe("/to/x");
  });
});
