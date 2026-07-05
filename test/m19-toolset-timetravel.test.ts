import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { makeToolset } from "../src/toolset";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";
import type { Json } from "../src/types";

function setup(initial: Json = { docs: { a: "v1" } }) {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson(initial, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0) });
  return { tree, addressing, log, mutator, ts: makeToolset({ tree, addressing, log, mutator }) };
}

describe("M19 toolset getAt/revert — scoped time-travel reads and append-only undo", () => {
  it("getAt happy path: past value at a captured version, current tree untouched", async () => {
    const s = setup();
    const v = s.log.length();
    const set = await s.ts.patch({ path: "/docs/a" }, { op: "set", value: "v2" });
    expect(set.ok).toBe(true);
    const r = await s.ts.getAt({ path: "/docs/a" }, v);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ value: "v1", existed: true });
    expect((s.tree.toJson() as { docs: { a: string } }).docs.a).toBe("v2");
  });

  it("getAt before the node existed → {value:null, existed:false}", async () => {
    const s = setup({ docs: {} });
    const ins = await s.ts.patch({ path: "/docs" }, { op: "insert", key: "a", value: "later" });
    expect(ins.ok).toBe(true);
    const r = await s.ts.getAt({ path: "/docs/a" }, 0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ value: null, existed: false });
  });

  it("getAt outside readScope → SCOPE_VIOLATION", async () => {
    const s = setup({ docs: { a: "in" }, other: "out" });
    const scoped = makeToolset(
      { tree: s.tree, addressing: s.addressing, log: s.log, mutator: s.mutator },
      { readScope: "/docs" },
    );
    const r = await scoped.getAt({ path: "/other" }, s.log.length());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SCOPE_VIOLATION");
  });

  it("getAt below the compaction floor → INVALID_OP mentioning compacted history, never throws", async () => {
    const s = setup();
    await s.ts.patch({ path: "/docs/a" }, { op: "set", value: "v2" }); // seq 0
    await s.ts.patch({ path: "/docs/a" }, { op: "set", value: "v3" }); // seq 1
    s.log.compactTo(1);
    const r = await s.ts.getAt({ path: "/docs/a" }, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_OP");
      expect(r.error.message).toContain("compacted");
    }
  });

  it("revert happy path: restores the past value as a NEW append-only set, prior history intact", async () => {
    const s = setup();
    const v = s.log.length();
    await s.ts.patch({ path: "/docs/a" }, { op: "set", value: "v2" });
    const lenBefore = s.log.length();
    const r = await s.ts.revert({ path: "/docs/a" }, v);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.path).toBe("/docs/a");
      expect(r.value.id).toBe(s.addressing.byPath("/docs/a")!.id);
      expect(r.value.version).toBe(s.addressing.byPath("/docs/a")!.meta.version);
    }
    expect((s.tree.toJson() as { docs: { a: string } }).docs.a).toBe("v1");
    // Append-only: the log GREW by one new set event; nothing was rewritten.
    expect(s.log.length()).toBe(lenBefore + 1);
    const events = [...s.log.entries()];
    expect(events[0]!.after).toBe("v2"); // prior history intact
    const last = events[events.length - 1]!;
    expect(last.kind).toBe("set");
    expect(last.after).toBe("v1");
  });

  it("revert outside writeScope → SCOPE_VIOLATION, tree and log unchanged", async () => {
    const s = setup({ docs: { a: "in" }, note: "keep me intact" });
    const scoped = makeToolset(
      { tree: s.tree, addressing: s.addressing, log: s.log, mutator: s.mutator },
      { writeScope: "/docs" },
    );
    const r = await scoped.revert({ path: "/note" }, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SCOPE_VIOLATION");
    expect((s.tree.toJson() as { note: string }).note).toBe("keep me intact");
    expect(s.log.length()).toBe(0);
  });

  it("revert restores type and tags across a type-changing set", async () => {
    const s = setup();
    s.mutator.set({ path: "/docs/a" }, "typed-v1", { type: "T", tags: ["x"] }); // seq 0
    s.mutator.set({ path: "/docs/a" }, "typed-v2", { type: "U", tags: ["y"] }); // seq 1
    const r = await s.ts.revert({ path: "/docs/a" }, 1); // back to post-seq-0 state
    expect(r.ok).toBe(true);
    const node = s.addressing.byPath("/docs/a")!;
    expect(s.tree.toJson(node.id)).toBe("typed-v1");
    expect(node.type).toBe("T");
    expect(node.tags).toEqual(["x"]);
  });
});
