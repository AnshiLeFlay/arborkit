import type { MutationEvent } from "./event-log";
import { Mutator } from "./mutator";

/** The JSON-Pointer of the parent container of `pointer` ("" = root). Pointer
 *  separators are literal "/"; an in-key "/" is escaped "~1", so lastIndexOf is safe. */
function parentPointer(pointer: string): string {
  const i = pointer.lastIndexOf("/");
  return i <= 0 ? "" : pointer.slice(0, i);
}

/**
 * Re-apply ONE recorded event FORWARD onto a live tree via the `Mutator`, addressed by
 * the event's stable path(s). The inverse of replay's `reverseApplyValue`: set→`after`,
 * insert→insert `after`, remove→remove, move→to. Goes through the Mutator so
 * decomposition, typing (via `e.nodeType`), and the index hooks run exactly as in normal
 * operation. Node ids for touched subtrees are regenerated; the log/replay are
 * path-addressed, so that is invisible to consumers. Malformed/pre-M7 events (missing
 * paths) are skipped.
 */
export function applyEventForward(mutator: Mutator, e: MutationEvent): void {
  switch (e.kind) {
    case "set":
      if (e.path === undefined) return;
      mutator.set({ path: e.path }, e.after ?? null, e.nodeType === undefined ? {} : { type: e.nodeType });
      return;
    case "insert":
      if (e.path === undefined || e.key === null) return;
      mutator.insert(
        { path: parentPointer(e.path) },
        e.key,
        e.after ?? null,
        e.nodeType === undefined ? {} : { type: e.nodeType },
      );
      return;
    case "remove":
      if (e.path === undefined) return;
      mutator.remove({ path: e.path });
      return;
    case "move":
      if (e.fromPath === undefined || e.toPath === undefined || !e.to || e.to.key === null) return;
      mutator.move({ path: e.fromPath }, { path: parentPointer(e.toPath) }, e.to.key);
      return;
  }
}

/** Forward-apply a sequence of events, in order. */
export function replayForward(mutator: Mutator, events: readonly MutationEvent[]): void {
  for (const e of events) applyEventForward(mutator, e);
}
