import type { Json } from "./types";
import type { ArtifactTree } from "./artifact-tree";
import type { Addressing } from "./addressing";
import type { EventLog, MutationEvent } from "./event-log";
import type { Mutator } from "./mutator";
import { type Ref, InvalidOpError } from "./errors";
import { getAtPath, setAtPathMut, removeAtPathMut, insertAtPathMut } from "./json-edit";

/** Undo a single event on a JSON value IN PLACE (the caller owns `value` — it is the
 *  single upfront clone made by `reconstructValueAt`). The spliced-in `before` values
 *  are still cloned (M14): they protect the LOG from mutation through the output. */
function reverseApplyValue(value: Json, e: MutationEvent): Json {
  switch (e.kind) {
    case "set":
      return e.path === undefined ? value : setAtPathMut(value, e.path, structuredClone(e.before ?? null));
    case "insert":
      return e.path === undefined ? value : removeAtPathMut(value, e.path);
    case "remove":
      return e.path === undefined ? value : insertAtPathMut(value, e.path, structuredClone(e.before ?? null));
    case "move": {
      if (e.toPath === undefined || e.fromPath === undefined) return value;
      const moved = getAtPath(value, e.toPath) ?? null;
      const withoutMoved = removeAtPathMut(value, e.toPath);
      return insertAtPathMut(withoutMoved, e.fromPath, moved);
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

  /** The node's {type, tags} as of `version`, by scanning later events on its path.
   *  Move-aware: if the version-`version` occupant was moved away, follow it to its
   *  new path and keep scanning — its type/tags travel with it. If the scan exhausts
   *  on a FOLLOWED path, the occupant is the live node there — read it directly
   *  ("keep current" would read whatever now sits at the original path).
   *  type: string | null (untyped/absent) | undefined (unknown — keep current).
   *  tags: string[] ([] = untagged) | undefined (unknown/pre-M14 — keep current).
   *  Limitation (same as pre-M14): array-index paths can mis-resolve across sibling
   *  index shifts; exact for object paths. */
  private stateAt(
    path: string,
    version: number,
    addressing: Addressing,
  ): { type: string | null | undefined; tags: string[] | undefined } {
    const total = this.log.length();
    let p = path;
    for (let seq = Math.max(version, this.log.baseSeqValue()); seq < total; seq++) {
      const e = this.log.at(seq)!;
      if (e.kind === "move") {
        if (e.fromPath === p) {
          p = e.toPath ?? p; // occupant moved away — follow it
          continue;
        }
        if (e.toPath === p) return { type: null, tags: [] }; // something ELSE moved in → vacant at `version`
        continue;
      }
      if (e.path !== p) continue;
      if (e.kind === "set" || e.kind === "remove") {
        return {
          type: e.nodeTypeBefore === undefined ? undefined : e.nodeTypeBefore,
          tags: e.tagsBefore, // absent (pre-M14) → undefined = keep current
        };
      }
      if (e.kind === "insert") return { type: null, tags: [] }; // node did not exist at `version`
    }
    if (p !== path) {
      // Followed through moves and nothing later touched the occupant: it is the
      // live node at `p` — its type/tags are the version-`version` answer.
      const live = addressing.byPath(p);
      return { type: live?.type ?? null, tags: live?.tags ?? [] };
    }
    return { type: undefined, tags: undefined }; // untouched since `version` — keep current
  }

  /** Restore the node at `ref` to its value, type, AND tags as of `toVersion`, as a new live mutation. */
  revert(mutator: Mutator, addressing: Addressing, ref: Ref, toVersion: number): void {
    const path = "id" in ref ? addressing.pathOf(ref.id) : ref.path;
    const past = this.getAt(path, toVersion);
    const { type, tags } = this.stateAt(path, toVersion, addressing);
    const opts: { type?: string | null; tags?: string[] } = {};
    if (type !== undefined) opts.type = type;
    if (tags !== undefined) opts.tags = tags;
    mutator.set({ path }, past ?? null, opts);
  }
}
