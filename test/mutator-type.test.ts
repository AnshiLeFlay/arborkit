import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { type DecomposeDecision } from "../src/decompose";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator, type Validator } from "../src/mutator";
import { ValidationError } from "../src/errors";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

const decision: DecomposeDecision = {
  isOpaque(value, type) {
    if (type === "opaque") return true;
    return value === null || typeof value !== "object";
  },
};

function setup(json: unknown, validate?: Validator) {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision };
  const tree = ArtifactTree.fromJson(json as never, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock, validate });
  return { tree, addressing, log, mutator };
}

describe("Mutator type integration", () => {
  it("insert with a type sets node.type and passes the type to the validator", () => {
    const seen: Array<{ type?: string; op: string }> = [];
    const validate: Validator = ({ type, op }) => { seen.push({ type, op }); };
    const { tree, mutator } = setup({ a: 1 }, validate);
    const id = mutator.insert({ path: "" }, "b", 2, { type: "MyType" });
    expect(tree.get(id)!.type).toBe("MyType");
    expect(seen).toEqual([{ type: "MyType", op: "insert" }]);
  });

  it("set with opts.type retypes the node and validates with that type", () => {
    const seen: Array<string | undefined> = [];
    const validate: Validator = ({ type }) => { seen.push(type); };
    const { addressing, mutator } = setup({ a: 1 }, validate);
    mutator.set({ path: "/a" }, 2, { type: "T" });
    expect(addressing.byPath("/a")!.type).toBe("T");
    expect(seen).toEqual(["T"]);
  });

  it("set without opts.type reuses the node's existing type", () => {
    const seen: Array<string | undefined> = [];
    const validate: Validator = ({ type }) => { seen.push(type); };
    const { mutator } = setup({ a: 1 }, validate);
    mutator.set({ path: "/a" }, 2, { type: "T" });
    mutator.set({ path: "/a" }, 3);
    expect(seen).toEqual(["T", "T"]);
  });

  it("rejects when the validator throws, leaving tree and log untouched", () => {
    const validate: Validator = ({ proposed }) => {
      if (proposed === 99) throw new ValidationError("T", "nope");
    };
    const { tree, log, mutator } = setup({ a: 1 }, validate);
    expect(() => mutator.set({ path: "/a" }, 99, { type: "T" })).toThrow(ValidationError);
    expect(tree.toJson()).toEqual({ a: 1 });
    expect(log.length()).toBe(0);
  });

  it("applies the type's decompose override on insert", () => {
    const { tree, mutator } = setup({ a: 1 });
    const id = mutator.insert({ path: "" }, "blob", { x: 1, y: 2 }, { type: "opaque" });
    expect(tree.get(id)!.kind).toBe("leaf");
  });
});
