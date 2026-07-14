import { describe, expect, it } from "vitest";
import { Addressing } from "../src/addressing";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { FixedClock } from "../src/clock";
import { sizeBasedDecision } from "../src/decompose";
import { EventLog } from "../src/event-log";
import { SeqIdGen } from "../src/ids";
import { getAtPath, insertAtPath, removeAtPath, setAtPath } from "../src/json-edit";
import { Mutator } from "../src/mutator";
import { Replay } from "../src/replay";
import { makeToolset } from "../src/toolset";
import type { Json } from "../src/types";

// "__proto__" as a data key must behave like any other key. Plain `obj[key] =`
// assembly hits the prototype setter instead of creating an own property, which
// silently dropped the child from toJson/get/replay while the node still
// existed in the tree.

function setup(initial: Json = { pages: { home: { title: "Home" } } }) {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson(initial, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock });
  const tools = makeToolset({ tree, addressing, log, mutator }, { owner: "agent", writeScope: "/pages" });
  return { tree, addressing, log, mutator, tools };
}

describe('"__proto__" is an ordinary data key', () => {
  it("survives insert → toJson / toolset get, without prototype pollution", async () => {
    const { tree, mutator, tools } = setup();
    mutator.insert({ path: "/pages/home" }, "__proto__", { legacy: true });

    const json = tree.toJson() as Record<string, Json>;
    const home = (json["pages"] as Record<string, Json>)["home"] as Record<string, Json>;
    expect(Object.hasOwn(home, "__proto__")).toBe(true);
    expect(getAtPath(json, "/pages/home/__proto__")).toEqual({ legacy: true });
    expect(Object.getPrototypeOf(home)).toBe(Object.prototype);
    expect(Object.hasOwn(Object.prototype, "legacy")).toBe(false);

    const parent = await tools.get({ path: "/pages/home" });
    expect(parent.ok).toBe(true);
    if (parent.ok) {
      expect(Object.hasOwn(parent.value.content as object, "__proto__")).toBe(true);
    }
    const child = await tools.get({ path: "/pages/home/__proto__" });
    expect(child.ok).toBe(true);
    if (child.ok) expect(child.value.content).toEqual({ legacy: true });
  });

  it("round-trips through JSON.stringify/parse as an own property", () => {
    const { tree, mutator } = setup();
    mutator.insert({ path: "/pages/home" }, "__proto__", { legacy: true });
    const revived = JSON.parse(JSON.stringify(tree.toJson())) as Record<string, Json>;
    const home = (revived["pages"] as Record<string, Json>)["home"] as Record<string, Json>;
    expect(Object.hasOwn(home, "__proto__")).toBe(true);
  });

  it("json-edit reads and writes /__proto__ segments as own properties", () => {
    const withProto = insertAtPath({ a: {} }, "/a/__proto__", { x: 1 });
    const container = (withProto as Record<string, Json>)["a"] as Record<string, Json>;
    expect(Object.hasOwn(container, "__proto__")).toBe(true);
    expect(getAtPath(withProto, "/a/__proto__")).toEqual({ x: 1 });
    expect(getAtPath(withProto, "/a/__proto__/x")).toBe(1);

    // absent key reads as undefined, not as Object.prototype
    expect(getAtPath({ a: {} }, "/a/__proto__")).toBeUndefined();

    const replaced = setAtPath(withProto, "/a/__proto__", 7);
    expect(getAtPath(replaced, "/a/__proto__")).toBe(7);
    const removed = removeAtPath(replaced, "/a/__proto__");
    expect(getAtPath(removed, "/a/__proto__")).toBeUndefined();
  });

  it("replay reconstructs history across a __proto__ child", () => {
    const { tree, log, mutator } = setup();
    mutator.insert({ path: "/pages/home" }, "__proto__", "v1");
    const afterInsert = log.length();
    mutator.set({ path: "/pages/home/__proto__" }, "v2");

    const replay = new Replay(tree, log);
    expect(replay.getAt("/pages/home/__proto__", afterInsert)).toBe("v1");
    expect(replay.getAt("/pages/home/__proto__", log.length())).toBe("v2");
    expect(replay.getAt("/pages/home/__proto__", 0)).toBeUndefined();
  });
});
