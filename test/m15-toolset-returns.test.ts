import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { makeToolset } from "../src/toolset";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function setup() {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson({ docs: {}, list: ["a", "b", "c", "d"] }, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0) });
  return { tree, addressing, log, mutator, ts: makeToolset({ tree, addressing, log, mutator }) };
}

describe("M15 patch returns id/path/version", () => {
  it("insert → the new node's id, path, and version", async () => {
    const s = setup();
    const r = await s.ts.patch({ path: "/docs" }, { op: "insert", key: "a", value: "v1" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.path).toBe("/docs/a");
      expect(r.value.id).toBe(s.addressing.byPath("/docs/a")!.id);
      expect(r.value.version).toBe(s.addressing.byPath("/docs/a")!.meta.version);
    }
  });

  it("set → the node's bumped version (usable as the next ifVersion)", async () => {
    const s = setup();
    await s.ts.patch({ path: "/docs" }, { op: "insert", key: "a", value: "v1" });
    const r1 = await s.ts.patch({ path: "/docs/a" }, { op: "set", value: "v2" });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    // optimistic-concurrency chaining without a follow-up get:
    const r2 = await s.ts.patch({ path: "/docs/a" }, { op: "set", value: "v3", ifVersion: r1.value.version });
    expect(r2.ok).toBe(true);
    const stale = await s.ts.patch({ path: "/docs/a" }, { op: "set", value: "v4", ifVersion: r1.value.version });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("STALE_VERSION");
  });

  it("move → the moved node at its NEW path; remove → removed id with the parent's version", async () => {
    const s = setup();
    await s.ts.patch({ path: "/docs" }, { op: "insert", key: "a", value: "v1" });
    const moved = await s.ts.patch({ path: "/docs/a" }, { op: "move", to: { path: "" }, key: "top" });
    if (moved.ok) expect(moved.value.path).toBe("/top");
    const removed = await s.ts.patch({ path: "/top" }, { op: "remove" });
    expect(removed.ok).toBe(true);
    if (removed.ok) {
      expect(removed.value.path).toBe("/top"); // the pre-removal path
      expect(removed.value.version).toBe(s.tree.root().meta.version); // parent's post-op version
    }
  });
});

describe("M15 find reports truncation", () => {
  it("truncated=true when the limit stopped the walk; false when exhausted", async () => {
    const s = setup();
    const t = await s.ts.find({ pathPattern: "/list/*" }, { limit: 2 });
    expect(t.ok).toBe(true);
    if (t.ok) {
      expect(t.value.hits.length).toBe(2);
      expect(t.value.truncated).toBe(true);
    }
    const all = await s.ts.find({ pathPattern: "/list/*" });
    if (all.ok) {
      expect(all.value.hits.length).toBe(4);
      expect(all.value.truncated).toBe(false);
    }
  });

  it("read-scope violation reports the honest Access message", async () => {
    const s = setup();
    const scoped = makeToolset(
      { tree: s.tree, addressing: s.addressing, log: s.log, mutator: s.mutator },
      { readScope: "/docs" },
    );
    const r = await scoped.get({ path: "/list" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SCOPE_VIOLATION");
      expect(r.error.message).toContain("Access outside scope");
    }
  });
});
