import { describe, it, expect } from "vitest";
import { EventLog } from "../src/event-log";

function ev(kind: "set" | "insert" = "set") {
  return { kind, targetId: "n1", parentId: "n0", key: "k", ts: 0 } as const;
}

describe("M12 EventLog compaction", () => {
  it("append stamps absolute seqs; length is absolute", () => {
    const log = new EventLog();
    expect(log.append(ev()).seq).toBe(0);
    expect(log.append(ev()).seq).toBe(1);
    expect(log.length()).toBe(2);
    expect(log.baseSeqValue()).toBe(0);
  });

  it("compactTo drops the front, advances baseSeq, keeps seqs absolute, returns count", () => {
    const log = new EventLog();
    for (let i = 0; i < 5; i++) log.append(ev()); // seqs 0..4
    const dropped = log.compactTo(3); // drop seqs 0,1,2
    expect(dropped).toBe(3);
    expect(log.baseSeqValue()).toBe(3);
    expect(log.length()).toBe(5); // absolute next-seq unchanged
    expect(log.entries().map((e) => e.seq)).toEqual([3, 4]); // window
    expect(log.append(ev()).seq).toBe(5); // new seqs continue absolute
  });

  it("at(seq) maps absolute seq → window; undefined below floor / past end", () => {
    const log = new EventLog();
    for (let i = 0; i < 5; i++) log.append(ev());
    log.compactTo(2);
    expect(log.at(1)).toBeUndefined(); // compacted away
    expect(log.at(2)!.seq).toBe(2);
    expect(log.at(4)!.seq).toBe(4);
    expect(log.at(5)).toBeUndefined(); // past end
  });

  it("since() works across compaction (absolute seq filter)", () => {
    const log = new EventLog();
    for (let i = 0; i < 5; i++) log.append(ev());
    log.compactTo(2);
    expect(log.since(3).map((e) => e.seq)).toEqual([3, 4]);
    expect(log.since(0).map((e) => e.seq)).toEqual([2, 3, 4]); // below floor → only retained
  });

  it("compactTo clamps to [baseSeq, length] and is idempotent at the ceiling", () => {
    const log = new EventLog();
    for (let i = 0; i < 3; i++) log.append(ev());
    expect(log.compactTo(99)).toBe(3); // clamp to length → drop all history
    expect(log.entries()).toEqual([]);
    expect(log.length()).toBe(3);
    expect(log.compactTo(0)).toBe(0); // below baseSeq → no-op
    expect(log.compactTo(3)).toBe(0); // at ceiling → no-op
  });

  it("truncateTo is baseSeq-aware (transaction rollback past a compacted log)", () => {
    const log = new EventLog();
    for (let i = 0; i < 5; i++) log.append(ev());
    log.compactTo(2); // baseSeq 2, window seqs 2,3,4
    log.truncateTo(3); // roll back to absolute length 3 → keep seqs 2 only
    expect(log.entries().map((e) => e.seq)).toEqual([2]);
    expect(log.length()).toBe(3);
  });

  it("fromStored restores the baseSeq floor", () => {
    const log = new EventLog();
    for (let i = 0; i < 4; i++) log.append(ev());
    log.compactTo(2);
    const restored = EventLog.fromStored([...log.entries()], log.baseSeqValue());
    expect(restored.baseSeqValue()).toBe(2);
    expect(restored.length()).toBe(4);
    expect(restored.at(2)!.seq).toBe(2);
    expect(restored.at(1)).toBeUndefined();
  });
});
