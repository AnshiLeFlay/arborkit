import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator, type Validator } from "../src/mutator";
import { ScopeViolationError, StaleVersionError } from "../src/errors";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";
import { sizeBasedDecision } from "../src/decompose";

function setup(json: unknown, validate?: Validator) {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(5) };
  const tree = ArtifactTree.fromJson(json as never, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock, validate });
  return { tree, addressing, log, mutator };
}

describe("Mutator write-scope", () => {
  it("allows a write at or under the scope", () => {
    const { tree, mutator } = setup({ pages: [{ title: "Home" }] });
    mutator.set({ path: "/pages/0/title" }, "Hi", { writeScope: "/pages/0" });
    expect(tree.toJson()).toEqual({ pages: [{ title: "Hi" }] });
  });

  it("rejects a write outside the scope and leaves the tree and log untouched", () => {
    const { tree, log, mutator } = setup({ pages: [{ title: "Home" }, { title: "About" }] });
    expect(() => mutator.set({ path: "/pages/1/title" }, "X", { writeScope: "/pages/0" })).toThrow(
      ScopeViolationError,
    );
    expect(tree.toJson()).toEqual({ pages: [{ title: "Home" }, { title: "About" }] });
    expect(log.length()).toBe(0);
  });
});

describe("Mutator optimistic version", () => {
  it("applies when ifVersion matches", () => {
    const { tree, mutator } = setup({ a: 1 });
    mutator.set({ path: "/a" }, 2, { ifVersion: 0 });
    expect(tree.toJson()).toEqual({ a: 2 });
  });

  it("rejects when ifVersion is stale and records nothing", () => {
    const { tree, log, mutator } = setup({ a: 1 });
    mutator.set({ path: "/a" }, 2); // bumps version to 1
    expect(() => mutator.set({ path: "/a" }, 3, { ifVersion: 0 })).toThrow(StaleVersionError);
    expect(tree.toJson()).toEqual({ a: 2 });
    expect(log.length()).toBe(1);
  });
});

describe("Mutator validator hook", () => {
  it("blocks a mutation when the validator throws, leaving tree and log untouched", () => {
    const validate: Validator = ({ proposed }) => {
      if (proposed === "bad") throw new Error("rejected by validator");
    };
    const { tree, log, mutator } = setup({ a: "ok" }, validate);
    expect(() => mutator.set({ path: "/a" }, "bad")).toThrow("rejected by validator");
    expect(tree.toJson()).toEqual({ a: "ok" });
    expect(log.length()).toBe(0);
  });

  it("allows a mutation the validator accepts", () => {
    const validate: Validator = ({ proposed }) => {
      if (proposed === "bad") throw new Error("rejected");
    };
    const { tree, mutator } = setup({ a: "ok" }, validate);
    mutator.set({ path: "/a" }, "fine");
    expect(tree.toJson()).toEqual({ a: "fine" });
  });
});
