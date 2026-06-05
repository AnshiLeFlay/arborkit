import { describe, it, expect } from "vitest";
import { EventLog, type MutationEvent } from "../src/event-log";

function sampleEvent(): Omit<MutationEvent, "seq"> {
  return { kind: "set", targetId: "n1", parentId: "n0", key: "title", before: "Old", after: "New", ts: 0 };
}

describe("EventLog", () => {
  it("assigns monotonically increasing seq starting at 0", () => {
    const log = new EventLog();
    const a = log.append(sampleEvent());
    const b = log.append(sampleEvent());
    expect(a.seq).toBe(0);
    expect(b.seq).toBe(1);
    expect(log.length()).toBe(2);
  });

  it("preserves the appended payload alongside the seq", () => {
    const log = new EventLog();
    const e = log.append(sampleEvent());
    expect(e.kind).toBe("set");
    expect(e.before).toBe("Old");
    expect(e.after).toBe("New");
  });

  it("entries() returns all events in order", () => {
    const log = new EventLog();
    log.append(sampleEvent());
    log.append({ ...sampleEvent(), kind: "remove" });
    expect(log.entries().map((e) => e.kind)).toEqual(["set", "remove"]);
  });

  it("since(seq) returns events at or after a seq", () => {
    const log = new EventLog();
    log.append(sampleEvent());
    log.append(sampleEvent());
    log.append(sampleEvent());
    expect(log.since(1).map((e) => e.seq)).toEqual([1, 2]);
  });

  it("truncateTo(length) drops trailing events (transaction rollback support)", () => {
    const log = new EventLog();
    log.append(sampleEvent());
    log.append(sampleEvent());
    log.truncateTo(1);
    expect(log.length()).toBe(1);
    expect(log.entries().map((e) => e.seq)).toEqual([0]);
  });
});
