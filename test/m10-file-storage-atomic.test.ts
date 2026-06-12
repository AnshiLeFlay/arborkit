import { describe, it, expect, afterEach } from "vitest";
import { rm, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { FileStorage } from "../src/file-storage";
import type { StoredArtifact } from "../src/storage";

const dir = mkdtempSync(join(tmpdir(), "arbor-m10-fs-"));
const path = join(dir, "artifact.json");

function sample(): StoredArtifact {
  return {
    version: 1,
    rootId: "n0",
    nodes: [
      { id: "n0", parentId: null, key: null, kind: "leaf", content: "x", childIds: [], meta: { version: 0, updatedAt: 0, embedding: { state: "none" } } },
    ],
    events: [],
    vectors: [],
  };
}

describe("M10: FileStorage atomic save + validated load", () => {
  afterEach(async () => {
    await rm(path, { force: true });
    await rm(path + ".tmp", { force: true });
  });

  it("save leaves no .tmp file behind and round-trips", async () => {
    const store = new FileStorage(path);
    await store.save(sample());
    const names = await readdir(dir);
    expect(names).toContain("artifact.json");
    expect(names.some((n) => n.endsWith(".tmp"))).toBe(false);
    expect(await store.load()).toEqual(sample());
  });

  it("load of corrupt JSON throws a clear error (not a bare SyntaxError pass-through into restore)", async () => {
    await writeFile(path, "{ this is not json", "utf8");
    await expect(new FileStorage(path).load()).rejects.toThrow(/FileStorage: corrupt/);
  });

  it("load of valid JSON with the wrong shape throws a clear error", async () => {
    await writeFile(path, JSON.stringify({ hello: "world" }), "utf8");
    await expect(new FileStorage(path).load()).rejects.toThrow(/FileStorage: invalid/);
  });

  it("missing file still returns null", async () => {
    expect(await new FileStorage(join(dir, "absent.json")).load()).toBeNull();
  });
});
