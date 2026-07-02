import { describe, it, expect } from "vitest";
import { createArbor, restoreArbor } from "../src/arbor";
import { MockEmbeddingPort } from "../src/embedding-port";
import { MemoryDeltaStorage } from "../src/delta-storage";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";
import { sizeBasedDecision } from "../src/decompose";

describe("M15 capstone: facade lifecycle under agent traffic", () => {
  it("create → scoped agents write → delta persist → restore → history + search survive", async () => {
    const delta = new MemoryDeltaStorage();
    const mk = () => ({
      idGen: new SeqIdGen(),
      clock: new FixedClock(0),
      decompose: sizeBasedDecision(1),
      embedding: new MockEmbeddingPort(),
      delta,
    });

    const run1 = createArbor({ ...mk(), initial: { pages: {}, plan: "" } });
    await run1.checkpoint();
    const writer = run1.toolset({ owner: "writer", writeScope: "/pages", readScope: "/pages" });
    const w1 = await writer.patch({ path: "/pages" }, { op: "insert", key: "home", value: "welcome home page" });
    expect(w1.ok).toBe(true);
    const w2 = await writer.patch({ path: "/plan" }, { op: "set", value: "hacked" });
    expect(w2.ok).toBe(false); // scope holds through the facade
    await run1.index!.reindex();
    await run1.saveDelta();

    const run2 = await restoreArbor(mk());
    expect(run2).not.toBeNull();
    expect(run2!.tree.toJson()).toEqual({ pages: { home: "welcome home page" }, plan: "" });
    await run2!.index!.reindex(); // delta-restored stale nodes re-embed (M14 fix)
    const found = await run2!.index!.search("welcome home page");
    expect(found.results[0]!.path).toBe("/pages/home");
    expect(found.staleCount).toBe(0);
    expect(run2!.replay.getAt("/pages/home", run2!.log.length())).toBe("welcome home page");
    // post-restore mutation with the deterministic gen is safe (facade guard)
    run2!.mutator.insert({ path: "/pages" }, "about", "about us");
    expect(run2!.addressing.pathOf(run2!.addressing.byPath("/pages/about")!.id)).toBe("/pages/about");
  });
});
