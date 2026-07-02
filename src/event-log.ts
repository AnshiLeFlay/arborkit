import type { Json, NodeId } from "./types";
import { InvalidOpError } from "./errors";

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

/** Append-only log of mutations with monotonic, absolute seq. Supports compaction:
 *  events before `baseSeq` are dropped, but retained events keep their absolute seq
 *  and `length()` stays the absolute next-seq, so versions never shift. */
export class EventLog {
  private readonly events: MutationEvent[] = [];
  private baseSeq = 0; // count of compacted-away events; events[0].seq === baseSeq

  append(event: Omit<MutationEvent, "seq">): MutationEvent {
    const full: MutationEvent = { ...event, seq: this.baseSeq + this.events.length };
    this.events.push(full);
    return full;
  }

  entries(): readonly MutationEvent[] {
    return this.events;
  }

  /** Absolute seq of the oldest retained event (0 until compaction). Versions below
   *  this have been compacted away and are no longer reconstructable. */
  baseSeqValue(): number {
    return this.baseSeq;
  }

  /** The event at absolute `seq`, or undefined if compacted away / past the end. */
  at(seq: number): MutationEvent | undefined {
    const i = seq - this.baseSeq;
    return i >= 0 && i < this.events.length ? this.events[i] : undefined;
  }

  since(seq: number): MutationEvent[] {
    return this.events.filter((e) => e.seq >= seq);
  }

  /** Absolute next-seq / current version (unchanged across compaction). */
  length(): number {
    return this.baseSeq + this.events.length;
  }

  /** Drop events past absolute `length` — used to roll back a failed transaction.
   *  Throws below the compaction floor: that history is gone and the log cannot roll
   *  back past it — `compactTo` must never run inside a transaction. */
  truncateTo(length: number): void {
    if (length < this.baseSeq) {
      throw new InvalidOpError(
        `cannot truncate to ${length}: events before ${this.baseSeq} were compacted away (compactTo must not run inside a transaction)`,
      );
    }
    this.events.length = length - this.baseSeq;
  }

  /** Compaction: drop every retained event with seq < `floorSeq` (history before it
   *  becomes unreconstructable). `floorSeq` is clamped to [baseSeq, length()].
   *  Returns the number of events dropped. Must NOT be called inside a Mutator
   *  transaction (rollback would need the dropped events). */
  compactTo(floorSeq: number): number {
    const floor = Math.max(this.baseSeq, Math.min(floorSeq, this.length()));
    const drop = floor - this.baseSeq;
    if (drop > 0) {
      this.events.splice(0, drop);
      this.baseSeq = floor;
    }
    return drop;
  }

  /** Rebuild a log from previously serialized events, preserving their seq + the
   *  compaction floor. */
  static fromStored(events: MutationEvent[], baseSeq = 0): EventLog {
    const log = new EventLog();
    log.baseSeq = baseSeq;
    for (const e of events) log.events.push({ ...e });
    return log;
  }
}
