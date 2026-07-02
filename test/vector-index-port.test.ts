import { describe, it, expect } from "vitest";
import { MemoryVectorIndex } from "../src/vector-index-port";

describe("MemoryVectorIndex", () => {
  it("upserts vectors and ranks by cosine similarity (closest first)", async () => {
    const idx = new MemoryVectorIndex();
    await idx.upsert([
      { nodeId: "a", vector: [1, 0] },
      { nodeId: "b", vector: [0, 1] },
      { nodeId: "c", vector: [1, 1] },
    ]);
    const hits = await idx.search([1, 0], 3);
    expect(hits[0].nodeId).toBe("a");
    expect(hits[0].score).toBeCloseTo(1, 5);
    expect(hits.map((h) => h.nodeId)).toContain("c");
    expect(hits[hits.length - 1].nodeId).toBe("b");
  });

  it("respects k", async () => {
    const idx = new MemoryVectorIndex();
    await idx.upsert([
      { nodeId: "a", vector: [1, 0] },
      { nodeId: "b", vector: [0, 1] },
    ]);
    expect((await idx.search([1, 0], 1)).length).toBe(1);
  });

  it("upsert replaces an existing vector for the same nodeId", async () => {
    const idx = new MemoryVectorIndex();
    await idx.upsert([{ nodeId: "a", vector: [1, 0] }]);
    await idx.upsert([{ nodeId: "a", vector: [0, 1] }]);
    expect(await idx.size()).toBe(1);
  });

  it("remove drops a vector; has/size reflect membership", async () => {
    const idx = new MemoryVectorIndex();
    await idx.upsert([{ nodeId: "a", vector: [1, 0] }]);
    expect(await idx.has("a")).toBe(true);
    await idx.remove("a");
    expect(await idx.has("a")).toBe(false);
    expect(await idx.size()).toBe(0);
  });

  it("returns score 0 for a zero-magnitude vector (no NaN)", async () => {
    const idx = new MemoryVectorIndex();
    await idx.upsert([{ nodeId: "a", vector: [0, 0] }]);
    const hits = await idx.search([1, 0], 1);
    expect(hits[0].score).toBe(0);
  });
});
