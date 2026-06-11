import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { SemanticIndex } from "../src/semantic-index";
import { MockEmbeddingPort } from "../src/embedding-port";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { makeToolset, type ToolsetBinding } from "../src/toolset";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function setup(json: unknown, binding: ToolsetBinding = {}) {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson(json as never, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const index = new SemanticIndex(tree, addressing, new MockEmbeddingPort(), new MemoryVectorIndex());
  const mutator = new Mutator(tree, addressing, log, { clock, ...index.hooks() });
  const toolset = makeToolset({ tree, addressing, log, mutator, index }, binding);
  return { tree, addressing, log, mutator, index, toolset };
}

describe("Toolset.history honors readScope", () => {
  it("with no ref, returns only events whose path is within readScope", async () => {
    const { mutator, toolset } = setup({ pages: {}, secret: {} }, { readScope: "/pages" });
    mutator.insert({ path: "/pages" }, "a", "1"); // /pages/a — in scope
    mutator.insert({ path: "/secret" }, "s", "x"); // /secret/s — out of scope
    const r = await toolset.history();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.length).toBe(1);
      expect(r.value[0].path).toBe("/pages/a");
    }
  });

  it("rejects history(ref) for a node outside readScope", async () => {
    const { addressing, mutator, toolset } = setup({ pages: {}, secret: {} }, { readScope: "/pages" });
    mutator.insert({ path: "/secret" }, "s", "x");
    const sId = addressing.byPath("/secret/s")!.id;
    const r = await toolset.history({ id: sId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SCOPE_VIOLATION");
  });

  it("with no readScope, returns the full log (unchanged behavior)", async () => {
    const { mutator, toolset } = setup({ pages: {}, secret: {} });
    mutator.insert({ path: "/pages" }, "a", "1");
    mutator.insert({ path: "/secret" }, "s", "x");
    const r = await toolset.history();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.length).toBe(2);
  });
});

describe("Toolset.search honors readScope", () => {
  it("rejects a caller-supplied under outside readScope", async () => {
    const { toolset } = setup({ pages: {}, secret: {} }, { readScope: "/pages" });
    const r = await toolset.search("anything", { under: "/secret" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SCOPE_VIOLATION");
  });

  it("allows a caller-supplied under that is within readScope", async () => {
    const { mutator, index, toolset } = setup({ pages: { home: {} } }, { readScope: "/pages" });
    mutator.insert({ path: "/pages/home" }, "body", "the quick brown fox");
    await index.reindex();
    const r = await toolset.search("the quick brown fox", { under: "/pages/home" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.results.every((h) => h.path.startsWith("/pages/home"))).toBe(true);
  });
});
