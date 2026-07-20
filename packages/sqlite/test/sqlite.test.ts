import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  MigrationRequiredError,
  StaleArtifactError,
  durableRequestHash,
  openDurableArbor,
  sizeBasedDecision,
} from "arborkit";
import { SqliteDurableStore } from "../src/index";
import { SqliteVecIndex } from "../src/sqlite-vec";

const directories: string[] = [];
function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "arborkit-sqlite-"));
  directories.push(directory);
  return join(directory, "artifact.db");
}
const config = { decomposition: { id: "size-based", version: "1" } };
const arbor = { decompose: sizeBasedDecision(1), initial: { value: 0 } };

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SqliteDurableStore", () => {
  it("requires an explicit migration", async () => {
    const store = new SqliteDurableStore({ filename: databasePath() });
    await expect(store.load("missing")).rejects.toBeInstanceOf(MigrationRequiredError);
    await store.close();
  });

  it("persists, checkpoints, and restores an artifact", async () => {
    const path = databasePath();
    const store = new SqliteDurableStore({ filename: path });
    store.migrate();
    const session = await openDurableArbor({ artifactId: "demo", store, config, arbor });
    await session.transact({}, (state) => state.toolset().patch(
      { path: "/value" },
      { op: "set", value: 1 },
    ));
    await session.checkpoint({ keepLast: 1 });
    await store.close();

    const reopened = new SqliteDurableStore({ filename: path });
    const restored = await openDurableArbor({
      artifactId: "demo",
      store: reopened,
      config,
      arbor: { decompose: sizeBasedDecision(1) },
    });
    expect(restored.arbor.tree.toJson()).toEqual({ value: 1 });
    expect(restored.version).toBe(1);
    await reopened.close();
  });

  it("deduplicates retries and rejects a stale second connection", async () => {
    const path = databasePath();
    const storeA = new SqliteDurableStore({ filename: path });
    storeA.migrate();
    const a = await openDurableArbor({ artifactId: "shared", store: storeA, config, arbor });
    const storeB = new SqliteDurableStore({ filename: path });
    const b = await openDurableArbor({
      artifactId: "shared",
      store: storeB,
      config,
      arbor: { decompose: sizeBasedDecision(1) },
    });
    const hash = durableRequestHash({ value: 1 });
    const first = await a.transact({ idempotencyKey: "one", requestHash: hash }, (state) =>
      state.toolset().patch({ path: "/value" }, { op: "set", value: 1 }),
    );
    const replayed = await a.transact({ idempotencyKey: "one", requestHash: hash }, () => null);
    expect(replayed.replayed).toBe(true);
    expect(replayed.value).toEqual(first.value);
    await expect(b.transact({}, (state) =>
      state.toolset().patch({ path: "/value" }, { op: "set", value: 2 }),
    )).rejects.toBeInstanceOf(StaleArtifactError);
    expect(b.arbor.tree.toJson()).toEqual({ value: 1 });
    await storeA.close();
    await storeB.close();
  });
});

describe("SqliteVecIndex", () => {
  it("persists vectors and applies artifact metadata filters", async () => {
    const db = new Database(":memory:");
    const index = new SqliteVecIndex({ db, artifactId: "a", dimensions: 2 });
    index.initialize();
    await index.upsert([
      { nodeId: "n1", vector: [1, 0], metadata: { scopePaths: ["", "/docs"], type: "doc", tags: ["keep"], textHash: "h1" } },
      { nodeId: "n2", vector: [0.9, 0.1], metadata: { scopePaths: ["", "/other"], type: "doc", tags: [], textHash: "h2" } },
    ]);
    const hits = await index.search([1, 0], 2, { under: "/docs", tag: "keep" });
    expect(hits.map((hit) => hit.nodeId)).toEqual(["n1"]);
    expect((await index.metadata(["n1"])).get("n1")?.textHash).toBe("h1");
    db.close();
  });
});
