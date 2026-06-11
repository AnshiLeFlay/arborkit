import type { Json } from "./types";
import type { ArtifactTree } from "./artifact-tree";
import type { Addressing } from "./addressing";
import type { EventLog, MutationEvent } from "./event-log";
import type { Mutator } from "./mutator";
import type { Ref } from "./errors";
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

  /** The whole artifact's JSON value as of `version` (0 = initial, log.length = current). */
  reconstructValueAt(version: number): Json {
    const total = this.log.length();
    const target = Math.max(0, Math.min(version, total));
    let value: Json = structuredClone(this.tree.toJson());
    const events = this.log.entries();
    for (let seq = total - 1; seq >= target; seq--) {
      value = reverseApplyValue(value, events[seq]);
    }
    return value;
  }

  /** The value at JSON Pointer `path` as of `version`, or undefined if absent then. */
  getAt(path: string, version: number): Json | undefined {
    return getAtPath(this.reconstructValueAt(version), path);
  }

  /** The mutations applied between version `vA` (inclusive) and `vB` (exclusive). */
  diff(vA: number, vB: number): MutationEvent[] {
    return [...this.log.entries()].slice(vA, vB);
  }

  /** Restore the node at `ref` to its value as of `toVersion`, as a new live mutation via `mutator`. */
  revert(mutator: Mutator, addressing: Addressing, ref: Ref, toVersion: number): void {
    const path = "id" in ref ? addressing.pathOf(ref.id) : ref.path;
    const past = this.getAt(path, toVersion);
    mutator.set({ path }, past ?? null);
  }
}
