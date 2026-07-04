import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { makeToolset } from "../src/toolset";
import { Replay } from "../src/replay";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";
import type { Json } from "../src/types";

function setup(initial: Json = { docs: { a: "Bonus: 100% do 2000 PLN. Graj!" } }) {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson(initial, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0) });
  return { tree, addressing, log, mutator, ts: makeToolset({ tree, addressing, log, mutator }) };
}

describe("M18 patch op 'edit' — exact-substring surgery on string leaves", () => {
  it("happy path: replaces the fragment, returns path/version, logs a plain 'set' with full before/after", async () => {
    const s = setup();
    const r = await s.ts.patch({ path: "/docs/a" }, { op: "edit", old: "100% do 2000 PLN", new: "150% do 3000 PLN" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.path).toBe("/docs/a");
      expect(r.value.version).toBe(s.addressing.byPath("/docs/a")!.meta.version);
      expect(r.value.version).toBeGreaterThan(0);
    }
    expect((s.tree.toJson() as { docs: { a: string } }).docs.a).toBe("Bonus: 150% do 3000 PLN. Graj!");
    const events = [...s.log.entries()];
    expect(events.length).toBe(1);
    expect(events[0]!.kind).toBe("set");
    expect(events[0]!.before).toBe("Bonus: 100% do 2000 PLN. Graj!");
    expect(events[0]!.after).toBe("Bonus: 150% do 3000 PLN. Graj!");
  });

  it("old string not found → INVALID_OP, tree unchanged, log empty", async () => {
    const s = setup();
    const r = await s.ts.patch({ path: "/docs/a" }, { op: "edit", old: "nope", new: "whatever" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_OP");
      expect(r.error.message).toContain("not found");
    }
    expect((s.tree.toJson() as { docs: { a: string } }).docs.a).toBe("Bonus: 100% do 2000 PLN. Graj!");
    expect([...s.log.entries()].length).toBe(0);
  });

  it("ambiguous old → INVALID_OP with the occurrence count; replaceAll:true replaces every occurrence", async () => {
    const s = setup({ docs: { a: "aa bb aa" } });
    const r = await s.ts.patch({ path: "/docs/a" }, { op: "edit", old: "aa", new: "XX" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_OP");
      expect(r.error.message).toContain("2");
    }
    const all = await s.ts.patch({ path: "/docs/a" }, { op: "edit", old: "aa", new: "XX", replaceAll: true });
    expect(all.ok).toBe(true);
    expect((s.tree.toJson() as { docs: { a: string } }).docs.a).toBe("XX bb XX");
  });

  it("guards: empty old and old === new are INVALID_OP", async () => {
    const s = setup();
    const empty = await s.ts.patch({ path: "/docs/a" }, { op: "edit", old: "", new: "x" });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe("INVALID_OP");
    const same = await s.ts.patch({ path: "/docs/a" }, { op: "edit", old: "Graj!", new: "Graj!" });
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.error.code).toBe("INVALID_OP");
  });

  it("non-string target → INVALID_OP hinting at targeting a string field", async () => {
    const s = setup();
    const r = await s.ts.patch({ path: "/docs" }, { op: "edit", old: "Bonus", new: "Malus" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_OP");
      expect(r.error.message).toContain("string field");
    }
  });

  it("write-scope: edit on an out-of-scope string leaf → SCOPE_VIOLATION, value unchanged", async () => {
    const s = setup({ docs: { a: "in scope" }, note: "keep me intact" });
    const scoped = makeToolset(
      { tree: s.tree, addressing: s.addressing, log: s.log, mutator: s.mutator },
      { writeScope: "/docs" },
    );
    const r = await scoped.patch({ path: "/note" }, { op: "edit", old: "intact", new: "broken" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SCOPE_VIOLATION");
    expect((s.tree.toJson() as { note: string }).note).toBe("keep me intact");
  });

  it("stale ifVersion → STALE_VERSION", async () => {
    const s = setup();
    const first = await s.ts.patch({ path: "/docs/a" }, { op: "edit", old: "2000", new: "2500" });
    expect(first.ok).toBe(true);
    const stale = await s.ts.patch({ path: "/docs/a" }, { op: "edit", old: "2500", new: "3000", ifVersion: 0 });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("STALE_VERSION");
  });

  it("new containing replacement-pattern characters ($&) is inserted literally", async () => {
    const s = setup({ docs: { a: "price: 100" } });
    const r = await s.ts.patch({ path: "/docs/a" }, { op: "edit", old: "100", new: "$& 200" });
    expect(r.ok).toBe(true);
    expect((s.tree.toJson() as { docs: { a: string } }).docs.a).toBe("price: $& 200");
  });

  it("time travel intact: Replay.getAt before the edit returns the original string", async () => {
    const s = setup();
    const versionBefore = s.log.length();
    const r = await s.ts.patch({ path: "/docs/a" }, { op: "edit", old: "100% do 2000 PLN", new: "150% do 3000 PLN" });
    expect(r.ok).toBe(true);
    const replay = new Replay(s.tree, s.log);
    expect(replay.getAt("/docs/a", versionBefore)).toBe("Bonus: 100% do 2000 PLN. Graj!");
  });
});
