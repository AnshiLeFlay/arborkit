import { readFile, writeFile, rename } from "node:fs/promises";
import type { StoredArtifact, StoragePort } from "./storage";

function isStoredArtifact(v: unknown): v is StoredArtifact {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    (a["version"] === 1 || a["version"] === 2) &&
    typeof a["rootId"] === "string" &&
    Array.isArray(a["nodes"]) &&
    Array.isArray(a["events"]) &&
    Array.isArray(a["vectors"])
  );
}

/**
 * File-backed StoragePort: one JSON file per artifact. `load` returns null if the
 * file is absent. Saves are atomic (write tmp, then rename) so a crash mid-write
 * never corrupts an existing artifact; loads validate the parsed shape.
 */
export class FileStorage implements StoragePort {
  constructor(private readonly path: string) {}

  async save(artifact: StoredArtifact): Promise<void> {
    const tmp = this.path + ".tmp";
    await writeFile(tmp, JSON.stringify(artifact), "utf8");
    await rename(tmp, this.path);
  }

  async load(): Promise<StoredArtifact | null> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`FileStorage: corrupt artifact file ${this.path}: ${detail}`);
    }
    if (!isStoredArtifact(parsed)) {
      throw new Error(`FileStorage: invalid artifact file ${this.path} (unrecognized shape)`);
    }
    return parsed;
  }
}
