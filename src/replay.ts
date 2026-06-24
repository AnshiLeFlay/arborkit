import type { Json } from "./types";
import type { ArtifactTree } from "./artifact-tree";
import type { Addressing } from "./addressing";
import type { EventLog, MutationEvent } from "./event-log";
import type { Mutator } from "./mutator";
import { type Ref, InvalidOpError } from "./errors";
import { getAtPath, setAtPath, removeAtPath, insertAtPath } from "./json-edit";

/** Undo a single event on a JSON value, addressed by the event's recorded path(s). */
function reverseApplyValue(value: Json, e: MutationEvent): Json {
  switch (e.kind) {
    case "set":
      return e.path === undefined ? value : setAtPath(value, e.path, e.before ?? null);
    case "insert":
      return e.path === undefined ? value : removeAtPath(value, e.path);
    case "remove":
      return e.path === undefined ? value : insertAtPath(value, e.path, e.before ?? null);
    case "move": {
      if (e.toPath === undefined || e.fromPath === undefined) return value;
      const moved = getAtPath(value, e.toPath) ?? null;
      const withoutMoved = removeAtPath(value, e.toPath);
      return insertAtPath(withoutMoved, e.fromPath, moved);
    }
  }
}

/** Value-level time-travel over the reversible event-log. */
export class Replay {
  constructor(
    private readonly tree: ArtifactTree,
    private readonly log: EventLog,
  ) {}

  /** The whole artifact's JSON value as of `version` (0 = initial, log.length = current).
   *  Throws if `version` is below the compaction floor (that history was dropped). */
  reconstructValueAt(version: number): Json {
    const total = this.log.length();
    const floor = this.log.baseSeqValue();
    if (version < floor) {
      throw new InvalidOpError(`cannot reconstruct version ${version}: history before ${floor} was compacted`);
    }
    const target = Math.min(version, total);
    let value: Json = structuredClone(this.tree.toJson());
    for (let seq = total - 1; seq >= target; seq--) {
      value = reverseApplyValue(value, this.log.at(seq)!);
    }
    return value;
  }

  /** The value at JSON Pointer `path` as of `version`, or undefined if absent then. */
  getAt(path: string, version: number): Json | undefined {
    return getAtPath(this.reconstructValueAt(version), path);
  }

  /** The mutations applied between version `vA` (inclusive) and `vB` (exclusive).
   *  Events compacted away are not included. */
  diff(vA: number, vB: number): MutationEvent[] {
    return this.log.since(vA).filter((e) => e.seq < vB);
  }

  /** The node's type as of `version`: a string (typed), null (untyped/absent), or
   *  undefined (unknown/unchanged since `version` — leave the current type alone). */
  private typeAt(path: string, version: number): string | null | undefined {
    const total = this.log.length();
    for (let seq = Math.max(version, this.log.baseSeqValue()); seq < total; seq++) {
      const e = this.log.at(seq)!;
      if (e.path !== path) continue;
      if (e.kind === "set" || e.kind === "remove") {
        return e.nodeTypeBefore === undefined ? undefined : e.nodeTypeBefore;
      }
      if (e.kind === "insert") return null;
    }
    return undefined;
  }

  /** Restore the node at `ref` to its value AND type as of `toVersion`, as a new live mutation. */
  revert(mutator: Mutator, addressing: Addressing, ref: Ref, toVersion: number): void {
    const path = "id" in ref ? addressing.pathOf(ref.id) : ref.path;
    const past = this.getAt(path, toVersion);
    const pastType = this.typeAt(path, toVersion);
    mutator.set({ path }, past ?? null, pastType === undefined ? {} : { type: pastType });
  }
}
