import { describe, it, expect } from "vitest";
import { EventLog } from "../src/event-log";
import { MemoryVectorIndex } from "../src/vector-index-port";

describe("EventLog.fromStored", () => {
  it("rebuilds a log from stored events, preserving seq and order", () => {
    const log = new EventLog();
    log.append({ kind: "set", targetId: "n1", parentId: "n0", key: "k", after: 1, ts: 0 });
    log.append({ kind: "remove", targetId: "n2", parentId: "n0", key: "j", before: 2, ts: 0 });
    const restored = EventLog.fromStored([...log.entries()]);
    expect(restored.length()).toBe(2);
    expect(restored.entries()).toEqual(log.entries());
  });

  it("a rebuilt log keeps appending from the right seq", () => {
    const log = new EventLog();
    log.append({ kind: "set", targetId: "n1", parentId: null, key: null, ts: 0 });
    const restored = EventLog.fromStored([...log.entries()]);
    const next = restored.append({ kind: "set", targetId: "n2", parentId: null, key: null, ts: 0 });
    expect(next.seq).toBe(1);
  });
});

describe("MemoryVectorIndex.entries", () => {
  it("dumps all entries, round-trippable via upsert", () => {
    const idx = new MemoryVectorIndex();
    idx.upsert([
      { nodeId: "a", vector: [1, 0] },
      { nodeId: "b", vector: [0, 1] },
    ]);
    const entries = idx.entries();
    expect(entries.length).toBe(2);
    const idx2 = new MemoryVectorIndex();
    idx2.upsert(entries);
    expect(idx2.size()).toBe(2);
    expect(idx2.has("a")).toBe(true);
  });
});
