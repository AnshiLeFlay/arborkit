import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { MemoryDeltaStorage, FileDeltaStorage } from "../src/delta-storage";
import type { StoredArtifact } from "../src/storage";
import type { MutationEvent } from "../src/event-log";

const dir = mkdtempSync(join(tmpdir(), "arbor-m13-"));

// A minimal checkpoint whose embedded events cover seqs [0, n).
function checkpoint(events: number[]): StoredArtifact {
  return {
    version: 2,
    rootId: "n0",
    nodes: [{ id: "n0", parentId: null, key: null, kind: "object", content: null, childIds: [], meta: { version: 0, updatedAt: 0, embedding: { state: "none" } } }],
    events: events.map((seq) => ev(seq)),
    baseSeq: events.length ? events[0] : 0,
    vectors: [],
  };
}
function ev(seq: number): MutationEvent {
  return { seq, kind: "set", targetId: "n0", parentId: null, key: "k", path: "/k", after: seq, ts: 0 };
}

describe("M13 DeltaStoragePort", () => {
  afterEach(async () => {
    await rm(join(dir, "cp.json"), { force: true });
    await rm(join(dir, "journal.ndjson"), { force: true });
  });

  for (const make of [
    () => new MemoryDeltaStorage(),
    () => new FileDeltaStorage(join(dir, "cp.json"), join(dir, "journal.ndjson")),
  ]) {
    it(`${make().constructor.name}: load before any checkpoint → null + empty journal`, async () => {
      const s = make();
      expect(await s.loadDelta()).toEqual({ checkpoint: null, journal: [] });
    });

    it(`${make().constructor.name}: checkpoint + append → loadDelta returns both`, async () => {
      const s = make();
      await s.writeCheckpoint(checkpoint([0, 1])); // covers seqs 0,1 → version 2
      await s.appendEvents([ev(2), ev(3)]);
      const { checkpoint: cp, journal } = await s.loadDelta();
      expect(cp!.events.map((e) => e.seq)).toEqual([0, 1]);
      expect(journal.map((e) => e.seq)).toEqual([2, 3]);
    });

    it(`${make().constructor.name}: writeCheckpoint clears the journal`, async () => {
      const s = make();
      await s.writeCheckpoint(checkpoint([0]));
      await s.appendEvents([ev(1)]);
      await s.writeCheckpoint(checkpoint([0, 1, 2])); // version 3
      expect((await s.loadDelta()).journal).toEqual([]);
    });

    it(`${make().constructor.name}: stale pre-checkpoint journal events are filtered`, async () => {
      const s = make();
      await s.writeCheckpoint(checkpoint([0, 1, 2])); // version 3
      await s.appendEvents([ev(1), ev(2), ev(3), ev(4)]); // 1,2 are stale (< 3)
      expect((await s.loadDelta()).journal.map((e) => e.seq)).toEqual([3, 4]);
    });
  }
});
