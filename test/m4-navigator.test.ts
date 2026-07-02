import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { Navigator } from "../src/navigator";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function setup() {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson({ pages: {}, brandFacts: {} }, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock });
  const nav = new Navigator(tree, addressing);
  mutator.insert({ path: "/pages" }, "home", { title: "Home", body: "<h1>Hi</h1>" }, { type: "PageContent" });
  mutator.insert({ path: "/pages" }, "about", { title: "About", body: "<p>Us</p>" }, { type: "PageContent" });
  mutator.insert({ path: "/brandFacts" }, "price", "2990", { tags: ["brand-fact:price"] });
  return { tree, addressing, mutator, nav };
}

describe("M4 navigator integration", () => {
  it("describe lists the top-level scaffold cheaply", () => {
    const { nav } = setup();
    const r = nav.describe();
    expect(r.children.map((c) => c.key).sort()).toEqual(["brandFacts", "pages"]);
  });

  it("find by type returns the page nodes", () => {
    const { nav } = setup();
    const hits = nav.find({ type: "PageContent" }).hits;
    expect(hits.map((h) => h.path).sort()).toEqual(["/pages/about", "/pages/home"]);
  });

  it("find by tag returns the brand fact", () => {
    const { nav } = setup();
    const hits = nav.find({ tag: "brand-fact:price" }).hits;
    expect(hits.map((h) => h.path)).toEqual(["/brandFacts/price"]);
  });

  it("find by glob returns the pages", () => {
    const { nav } = setup();
    const hits = nav.find({ pathPattern: "/pages/*" }).hits;
    expect(hits.map((h) => h.path).sort()).toEqual(["/pages/about", "/pages/home"]);
  });

  it("get returns a page's full content", () => {
    const { nav } = setup();
    const r = nav.get({ path: "/pages/home" });
    expect(r.type).toBe("PageContent");
    expect(r.content).toEqual({ title: "Home", body: "<h1>Hi</h1>" });
  });
});
