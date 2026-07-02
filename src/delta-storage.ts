import { readFile, writeFile, appendFile } from "node:fs/promises";
import type { MutationEvent } from "./event-log";
import type { StoredArtifact } from "./storage";
import { FileStorage } from "./file-storage";

/** A checkpoint snapshot plus the events journaled after it. */
export interface DeltaBundle {
  checkpoint: StoredArtifact | null;
  journal: MutationEvent[];
}

/**
 * Append-oriented persistence: a periodic full **checkpoint** + an appendable **journal**
 * of events after it. `appendEvents` is O(new events) — the per-save win over `StoragePort`,
 * which rewrites the whole artifact. Restore = checkpoint + forward-replayed journal
 * (see `restoreFromDelta`). Opt-in and independent of `StoragePort`.
 */
export interface DeltaStoragePort {
  /** Replace the checkpoint and clear the journal (the new checkpoint already embeds
   *  every event up to its version). */
  writeCheckpoint(artifact: StoredArtifact): Promise<void>;
  /** Append events to the journal (O(events)). */
  appendEvents(events: readonly MutationEvent[]): Promise<void>;
  /** The current checkpoint (or null) plus journaled events with `seq >=` the checkpoint
   *  version — stale pre-checkpoint events are filtered, making writeCheckpoint+clear
   *  crash-safe. */
  loadDelta(): Promise<DeltaBundle>;
}

/** The next-seq a checkpoint covers (absolute): baseSeq + embedded event count. */
function checkpointVersion(c: StoredArtifact | null): number {
  return c ? (c.baseSeq ?? 0) + c.events.length : 0;
}

/** In-memory DeltaStoragePort (deep-clones on the boundary). */
export class MemoryDeltaStorage implements DeltaStoragePort {
  private checkpoint: StoredArtifact | null = null;
  private journal: MutationEvent[] = [];

  async writeCheckpoint(artifact: StoredArtifact): Promise<void> {
    this.checkpoint = structuredClone(artifact);
    this.journal = [];
  }

  async appendEvents(events: readonly MutationEvent[]): Promise<void> {
    for (const e of events) this.journal.push(structuredClone(e));
  }

  async loadDelta(): Promise<DeltaBundle> {
    const v = checkpointVersion(this.checkpoint);
    return {
      checkpoint: this.checkpoint ? structuredClone(this.checkpoint) : null,
      journal: this.journal.filter((e) => e.seq >= v).map((e) => structuredClone(e)),
    };
  }
}

/**
 * File-backed DeltaStoragePort: the checkpoint is a JSON file (atomic + validated, via
 * `FileStorage`); the journal is an append-only NDJSON file (one event per line).
 * `writeCheckpoint` clears the journal; a torn final journal line (crash mid-append) is
 * treated as a truncated tail and ignored.
 */
export class FileDeltaStorage implements DeltaStoragePort {
  private readonly checkpointStore: FileStorage;

  constructor(
    checkpointPath: string,
    private readonly journalPath: string,
  ) {
    this.checkpointStore = new FileStorage(checkpointPath);
  }

  async writeCheckpoint(artifact: StoredArtifact): Promise<void> {
    await this.checkpointStore.save(artifact);
    await writeFile(this.journalPath, "", "utf8");
  }

  async appendEvents(events: readonly MutationEvent[]): Promise<void> {
    if (events.length === 0) return;
    // The leading "\n" isolates any torn tail left by a crash mid-append: new events
    // always start on a fresh line, and blank lines are skipped on load.
    const lines = "\n" + events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await appendFile(this.journalPath, lines, "utf8");
  }

  async loadDelta(): Promise<DeltaBundle> {
    const checkpoint = await this.checkpointStore.load();
    const v = checkpointVersion(checkpoint);
    let text = "";
    try {
      text = await readFile(this.journalPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const journal: MutationEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        journal.push(JSON.parse(line) as MutationEvent);
      } catch {
        continue; // torn/garbage line from a crash mid-append — skip it; restore validates contiguity
      }
    }
    return { checkpoint, journal: journal.filter((e) => e.seq >= v) };
  }
}
