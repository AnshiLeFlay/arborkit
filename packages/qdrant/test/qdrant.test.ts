import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { VectorDimensionMismatchError } from "arborkit";
import { QdrantVectorIndex, qdrantPointId } from "../src/index";

const url = process.env.ARBORKIT_TEST_QDRANT_URL;
const integration = describe.runIf(url !== undefined);
const collections: Array<{ index: QdrantVectorIndex; name: string }> = [];

afterAll(async () => {
  for (const { index, name } of collections) await index.client.deleteCollection(name).catch(() => undefined);
});

integration("QdrantVectorIndex", () => {
  it("namespaces artifacts and applies payload filters before top-k", async () => {
    const collection = `arborkit_test_${randomUUID().replaceAll("-", "")}`;
    const a = new QdrantVectorIndex({ url, collection, artifactId: "a", dimensions: 2 });
    const b = new QdrantVectorIndex({ client: a.client, collection, artifactId: "b", dimensions: 2 });
    collections.push({ index: a, name: collection });
    await a.ensureCollection();
    await a.upsert([
      { nodeId: "n1", vector: [1, 0], metadata: { scopePaths: ["", "/docs"], type: "doc", tags: ["keep"], textHash: "h1" } },
      { nodeId: "n2", vector: [0.99, 0.01], metadata: { scopePaths: ["", "/other"], type: "doc", tags: [], textHash: "h2" } },
    ]);
    await b.upsert([{ nodeId: "n1", vector: [1, 0], metadata: { scopePaths: [""], textHash: "other" } }]);
    const hits = await a.search([1, 0], 2, { under: "/docs", type: "doc", tag: "keep" });
    expect(hits.map((hit) => hit.nodeId)).toEqual(["n1"]);
    expect(await a.size()).toBe(2);
    expect(await b.size()).toBe(1);
    expect((await a.metadata(["n1"])).get("n1")?.textHash).toBe("h1");
    expect(qdrantPointId("a", "non-uuid")).toMatch(/^[0-9a-f-]{36}$/);

    const mismatched = new QdrantVectorIndex({ client: a.client, collection, artifactId: "a", dimensions: 3 });
    await expect(mismatched.ensureCollection({ createIfMissing: false }))
      .rejects.toBeInstanceOf(VectorDimensionMismatchError);
  });
});
