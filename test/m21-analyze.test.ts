import { describe, expect, it } from "vitest";
import { createArbor } from "../src/arbor";
import {
  classifyNearest,
  collectVectors,
  compareScores,
  kmeans,
  localOutlierScores,
  outlierScores,
  silhouette,
} from "../src/analyze";
import { sizeBasedDecision } from "../src/decompose";
import { MockEmbeddingPort } from "../src/embedding-port";

const A = { id: "a", vector: [0, 0] };
const B = { id: "b", vector: [0.1, 0] };
const C = { id: "c", vector: [10, 10] };
const D = { id: "d", vector: [10.1, 10] };

describe("M21 vector analytics", () => {
  it("runs deterministic seeded k-means and computes a real centroid for k=1", () => {
    const first = kmeans([A, B, C, D], { k: 2, seed: 7 });
    const second = kmeans([A, B, C, D], { k: 2, seed: 7 });
    expect(first).toEqual(second);
    expect(first.assignments[0]).toBe(first.assignments[1]);
    expect(first.assignments[2]).toBe(first.assignments[3]);
    expect(first.assignments[0]).not.toBe(first.assignments[2]);
    expect(kmeans([A, C], { k: 1 }).centroids[0]).toEqual([5, 5]);
  });

  it("returns global and local distance scores without verdicts", () => {
    const global = Object.fromEntries(outlierScores([A, B, C]).map((score) => [score.id, score.score]));
    expect(global.c).toBeGreaterThan(global.a);

    const items = [
      A,
      B,
      { id: "c0", vector: [0, 0.1] },
      { id: "x", vector: [5, 5] },
      C,
      D,
      { id: "c1", vector: [10, 10.1] },
    ];
    const local = Object.fromEntries(localOutlierScores(items, { k: 2 }).map((score) => [score.id, score.score]));
    expect(local.x).toBeGreaterThan(local.a);
    expect(local.x).toBeGreaterThan(local.c);
    expect(localOutlierScores([A], { k: 10 })).toEqual([{ id: "a", score: 0 }]);
  });

  it("computes silhouette and treats singleton clusters as score zero", () => {
    const clustered = kmeans([A, B, C, D], { k: 2, seed: 1 });
    const quality = silhouette([A, B, C, D], clustered.assignments);
    expect(quality.mean).toBeGreaterThan(0.8);
    expect(quality.perItem).toHaveLength(4);
    expect(silhouette([A, C], [0, 1]).perItem).toEqual([
      { id: "a", score: 0 },
      { id: "c", score: 0 },
    ]);
  });

  it("classifies by nearest labelled centroid and diffs numeric scores deterministically", () => {
    expect(classifyNearest([A, D], [
      { label: "L", vector: [0, 0] },
      { label: "R", vector: [10, 10] },
    ])).toEqual([
      { id: "a", label: "L" },
      { id: "d", label: "R" },
    ]);
    expect(compareScores({ b: 2, a: 1 }, { c: 3, b: 5 })).toEqual({
      added: ["c"],
      removed: ["a"],
      changed: [{ id: "b", from: 2, to: 5, delta: 3 }],
    });
  });
});

describe("M21 collectVectors", () => {
  it("projects indexed nodes with path/type/tags and combined filters", async () => {
    const arbor = createArbor({
      initial: { keep: { text: "alpha" }, drop: { text: "beta" } },
      embedding: new MockEmbeddingPort(),
      decompose: sizeBasedDecision(1),
    });
    arbor.mutator.set({ path: "/keep/text" }, "alpha", { type: "page", tags: ["published"] });
    await arbor.index!.reindex();

    const all = await collectVectors(arbor);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((entry) => Array.isArray(entry.vector) && typeof entry.path === "string")).toBe(true);
    const filtered = await collectVectors(arbor, { under: "/keep", type: "page", tag: "published" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toMatchObject({ path: "/keep/text", type: "page", tags: ["published"] });
  });

  it("optionally waits for stale embeddings", async () => {
    const arbor = createArbor({
      initial: { page: "before" },
      embedding: new MockEmbeddingPort(),
      decompose: sizeBasedDecision(1),
    });
    await arbor.index!.reindex();
    arbor.mutator.set({ path: "/page" }, "after");
    const before = await collectVectors(arbor, { freshness: "best-effort" });
    const after = await collectVectors(arbor, { freshness: "wait" });
    expect(after).toHaveLength(before.length);
    expect(after[0].vector).not.toEqual(before[0].vector);
  });
});
