import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { Navigator } from "../src/navigator";
import { Mutator } from "../src/mutator";
import { EventLog } from "../src/event-log";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function makeAll(json: unknown) {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson(json as never, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock });
  const nav = new Navigator(tree, addressing);
  return { tree, addressing, mutator, nav };
}

describe("Navigator.find", () => {
  it("finds nodes by exact type", () => {
    const { mutator, nav } = makeAll({ items: {} });
    mutator.insert({ path: "/items" }, "x", { v: 1 }, { type: "Widget" });
    mutator.insert({ path: "/items" }, "y", { v: 2 }, { type: "Widget" });
    mutator.insert({ path: "/items" }, "z", { v: 3 }, { type: "Other" });
    const hits = nav.find({ type: "Widget" });
    expect(hits.map((h) => h.path).sort()).toEqual(["/items/x", "/items/y"]);
    expect(hits.every((h) => h.type === "Widget")).toBe(true);
  });

  it("finds nodes by tag membership", () => {
    const { mutator, nav } = makeAll({ facts: {} });
    mutator.insert({ path: "/facts" }, "price", "2990", { tags: ["brand-fact:price"] });
    mutator.insert({ path: "/facts" }, "name", "Acme", { tags: ["brand-fact:name"] });
    const hits = nav.find({ tag: "brand-fact:price" });
    expect(hits.map((h) => h.path)).toEqual(["/facts/price"]);
  });

  it("finds nodes by glob pathPattern", () => {
    const { nav } = makeAll({ pages: { home: { t: 1 }, about: { t: 2 } } });
    const hits = nav.find({ pathPattern: "/pages/*" });
    expect(hits.map((h) => h.path).sort()).toEqual(["/pages/about", "/pages/home"]);
  });

  it("ANDs multiple selector fields", () => {
    const { mutator, nav } = makeAll({ pages: {} });
    mutator.insert({ path: "/pages" }, "a", { v: 1 }, { type: "Page", tags: ["draft"] });
    mutator.insert({ path: "/pages" }, "b", { v: 2 }, { type: "Page" });
    const hits = nav.find({ type: "Page", tag: "draft" });
    expect(hits.map((h) => h.path)).toEqual(["/pages/a"]);
  });

  it("respects the limit", () => {
    const { mutator, nav } = makeAll({ items: {} });
    mutator.insert({ path: "/items" }, "a", 1, { type: "T" });
    mutator.insert({ path: "/items" }, "b", 2, { type: "T" });
    mutator.insert({ path: "/items" }, "c", 3, { type: "T" });
    expect(nav.find({ type: "T" }, { limit: 2 }).length).toBe(2);
  });
});
