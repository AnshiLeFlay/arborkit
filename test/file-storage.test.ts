import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileStorage } from "../src/file-storage";
import type { StoredArtifact } from "../src/storage";

const path = join(tmpdir(), "arbor-m6-file-storage.test.json");

function sample(): StoredArtifact {
  return {
    version: 1,
    rootId: "n0",
    nodes: [
      { id: "n0", parentId: null, key: null, kind: "leaf", content: "x", childIds: [], meta: { version: 0, updatedAt: 0, embedding: { state: "none" } } },
    ],
    events: [],
    vectors: [{ nodeId: "n0", vector: [1, 2] }],
  };
}

describe("FileStorage", () => {
  afterEach(async () => {
    await rm(path, { force: true });
  });

  it("load returns null when the file does not exist", async () => {
    expect(await new FileStorage(path).load()).toBeNull();
  });

  it("round-trips a saved artifact through a JSON file", async () => {
    const store = new FileStorage(path);
    const a = sample();
    await store.save(a);
    expect(await store.load()).toEqual(a);
  });
});
