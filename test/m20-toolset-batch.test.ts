import { describe, expect, it } from "vitest";
import { Addressing } from "../src/addressing";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { FixedClock } from "../src/clock";
import { sizeBasedDecision } from "../src/decompose";
import { EventLog } from "../src/event-log";
import { SeqIdGen } from "../src/ids";
import { Mutator } from "../src/mutator";
import { makeToolset } from "../src/toolset";

function setup() {
  const clock = new FixedClock(10);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson({ docs: { title: "Draft", body: "Hello" }, outside: "locked" }, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock });
  const tools = makeToolset(
    { tree, addressing, log, mutator },
    { owner: "batch-agent", readScope: "/docs", writeScope: "/docs" },
  );
  return { tree, addressing, log, tools };
}

describe("M20 Toolset.batchPatch", () => {
  it("commits several operations atomically and returns one result per operation", async () => {
    const { tree, log, tools } = setup();
    const result = await tools.batchPatch([
      { ref: { path: "/docs/title" }, op: { op: "set", value: "Reviewed" } },
      { ref: { path: "/docs/body" }, op: { op: "edit", old: "Hello", new: "Hello world" } },
      { ref: { path: "/docs" }, op: { op: "insert", key: "status", value: "ready" } },
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(3);
    expect(tree.toJson()).toEqual({
      docs: { title: "Reviewed", body: "Hello world", status: "ready" },
      outside: "locked",
    });
    expect([...log.entries()].map((event) => event.actor)).toEqual([
      "batch-agent",
      "batch-agent",
      "batch-agent",
    ]);
  });

  it("rolls tree and event log back when a later operation fails", async () => {
    const { tree, addressing, log, tools } = setup();
    const titleVersion = addressing.byPath("/docs/title")!.meta.version;
    const before = structuredClone(tree.toJson());
    const result = await tools.batchPatch([
      { ref: { path: "/docs/title" }, op: { op: "set", value: "This must roll back" } },
      { ref: { path: "/outside" }, op: { op: "remove" } },
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SCOPE_VIOLATION");
    expect(tree.toJson()).toEqual(before);
    expect(log.length()).toBe(0);
    expect(addressing.byPath("/docs/title")!.meta.version).toBe(titleVersion);
  });

  it("rolls back earlier writes on a stale ifVersion", async () => {
    const { tree, addressing, log, tools } = setup();
    const live = addressing.byPath("/docs/body")!.meta.version;
    const result = await tools.batchPatch([
      { ref: { path: "/docs/title" }, op: { op: "set", value: "Rolled back" } },
      { ref: { path: "/docs/body" }, op: { op: "set", value: "No", ifVersion: live + 1 } },
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("STALE_VERSION");
    expect(tree.toJson()).toEqual({ docs: { title: "Draft", body: "Hello" }, outside: "locked" });
    expect(log.length()).toBe(0);
  });

  it("rejects an empty batch", async () => {
    const { tools } = setup();
    const result = await tools.batchPatch([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_OP");
  });
});
