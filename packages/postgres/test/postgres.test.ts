import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  StaleArtifactError,
  openDurableArbor,
  sizeBasedDecision,
} from "arborkit";
import { PgVectorIndex, PostgresDurableStore } from "../src/index";

const connectionString = process.env.ARBORKIT_TEST_POSTGRES_URL;
const integration = describe.runIf(connectionString !== undefined);
const pool = connectionString ? new Pool({ connectionString }) : undefined;
const schemas: string[] = [];
function schema(): string {
  const value = `arborkit_test_${randomUUID().replaceAll("-", "")}`;
  schemas.push(value);
  return value;
}
const config = { decomposition: { id: "size-based", version: "1" } };

afterAll(async () => {
  if (!pool) return;
  for (const name of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
  await pool.end();
});

integration("PostgresDurableStore", () => {
  it("persists state and rejects a competing writer", async () => {
    const name = schema();
    const storeA = new PostgresDurableStore({ pool: pool!, schema: name });
    await storeA.migrate();
    const a = await openDurableArbor({
      artifactId: "shared",
      store: storeA,
      config,
      arbor: { initial: { value: 0 }, decompose: sizeBasedDecision(1) },
    });
    const storeB = new PostgresDurableStore({ pool: pool!, schema: name });
    const b = await openDurableArbor({
      artifactId: "shared",
      store: storeB,
      config,
      arbor: { decompose: sizeBasedDecision(1) },
    });
    await a.transact({}, (state) => state.toolset().patch({ path: "/value" }, { op: "set", value: 1 }));
    await expect(b.transact({}, (state) =>
      state.toolset().patch({ path: "/value" }, { op: "set", value: 2 }),
    )).rejects.toBeInstanceOf(StaleArtifactError);
    expect(b.arbor.tree.toJson()).toEqual({ value: 1 });

    const restored = await openDurableArbor({
      artifactId: "shared",
      store: storeA,
      config,
      arbor: { decompose: sizeBasedDecision(1) },
    });
    expect(restored.arbor.tree.toJson()).toEqual({ value: 1 });
  });

  it("uses pgvector for filtered cosine search", async () => {
    const name = schema();
    const index = new PgVectorIndex({
      pool: pool!,
      schema: name,
      namespace: "docs",
      artifactId: "a",
      dimensions: 2,
    });
    await index.initialize({ installExtension: true });
    await index.upsert([
      { nodeId: "n1", vector: [1, 0], metadata: { scopePaths: ["", "/docs"], type: "doc", tags: ["keep"], textHash: "h1" } },
      { nodeId: "n2", vector: [0.9, 0.1], metadata: { scopePaths: ["", "/other"], type: "doc", tags: [], textHash: "h2" } },
    ]);
    expect((await index.search([1, 0], 2, { under: "/docs", tag: "keep" })).map((hit) => hit.nodeId))
      .toEqual(["n1"]);
    expect((await index.metadata(["n1"])).get("n1")?.textHash).toBe("h1");
  });
});
