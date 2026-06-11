import { readFile, writeFile } from "node:fs/promises";
import type { StoredArtifact, StoragePort } from "./storage";

/** File-backed StoragePort: one JSON file per artifact. `load` returns null if the file is absent. */
export class FileStorage implements StoragePort {
  constructor(private readonly path: string) {}

  async save(artifact: StoredArtifact): Promise<void> {
    await writeFile(this.path, JSON.stringify(artifact), "utf8");
  }

  async load(): Promise<StoredArtifact | null> {
    try {
      const text = await readFile(this.path, "utf8");
      return JSON.parse(text) as StoredArtifact;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }
}
