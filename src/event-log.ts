import type { Json, NodeId } from "./types";

export type OpKind = "set" | "insert" | "remove" | "move";

/**
 * A recorded mutation. Carries enough to reverse it later (M7 replay):
 * - set:    before = old subtree value, after = new value
 * - insert: after = inserted value (inverse is remove of targetId)
 * - remove: before = removed subtree value (inverse is insert at parentId/key)
 * - move:   from/to capture old and new (parentId, key)
 */
export interface MutationEvent {
  seq: number;
  kind: OpKind;
  targetId: NodeId;
  parentId: NodeId | null;
  key: string | number | null;
  before?: Json;
  after?: Json;
  from?: { parentId: NodeId | null; key: string | number | null };
  to?: { parentId: NodeId | null; key: string | number | null };
  /** JSON Pointer of the affected node (set/insert: its path; remove: its pre-removal path). */
  path?: string;
  /** move: source path (before the move). */
  fromPath?: string;
  /** move: destination path (after the move). */
  toPath?: string;
  /** set/remove: the node's type BEFORE the op; insert/set: `nodeType` = type AFTER.
   *  `null` = explicitly untyped; ABSENT = pre-M10 event (unknown — replay keeps the current type). */
  nodeTypeBefore?: string | null;
  nodeType?: string | null;
  actor?: string;
  ts: number;
}

/** Append-only log of mutations with monotonic seq. */
export class EventLog {
  private readonly events: MutationEvent[] = [];

  append(event: Omit<MutationEvent, "seq">): MutationEvent {
    const full: MutationEvent = { ...event, seq: this.events.length };
    this.events.push(full);
    return full;
  }

  entries(): readonly MutationEvent[] {
    return this.events;
  }

  since(seq: number): MutationEvent[] {
    return this.events.filter((e) => e.seq >= seq);
  }

  length(): number {
    return this.events.length;
  }

  /** Drop events past `length` — used to roll back a failed transaction. */
  truncateTo(length: number): void {
    this.events.length = length;
  }

  /** Rebuild a log from previously serialized events, preserving their seq. */
  static fromStored(events: MutationEvent[]): EventLog {
    const log = new EventLog();
    for (const e of events) log.events.push({ ...e });
    return log;
  }
}
