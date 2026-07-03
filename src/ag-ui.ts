// AG-UI adapter — expose the artifact tree + event log as AG-UI shared-state
// events (STATE_SNAPSHOT / STATE_DELTA with RFC 6902 JSON Patch ops). Zero-dep:
// these are plain objects shaped like AG-UI events, no AG-UI SDK required.
import type { Json } from "./types";
import type { ArtifactTree } from "./artifact-tree";
import type { EventLog, MutationEvent } from "./event-log";

/** RFC 6902 operation (the subset Arbor emits). */
export type JsonPatchOp =
  | { op: "replace" | "add"; path: string; value: Json }
  | { op: "remove"; path: string }
  | { op: "move"; from: string; path: string };

export interface AgUiStateSnapshot {
  type: "STATE_SNAPSHOT";
  snapshot: Json;
}

export interface AgUiStateDelta {
  type: "STATE_DELTA";
  delta: JsonPatchOp[];
}

/** One mutation event as an RFC 6902 op, or null for pre-M7 events without paths. */
export function toJsonPatch(e: MutationEvent): JsonPatchOp | null {
  switch (e.kind) {
    case "set":
      return e.path === undefined ? null : { op: "replace", path: e.path, value: e.after ?? null };
    case "insert":
      return e.path === undefined ? null : { op: "add", path: e.path, value: e.after ?? null };
    case "remove":
      return e.path === undefined ? null : { op: "remove", path: e.path };
    case "move":
      return e.fromPath === undefined || e.toPath === undefined
        ? null
        : { op: "move", from: e.fromPath, path: e.toPath };
  }
}

/** The full current state as an AG-UI STATE_SNAPSHOT event. */
export function snapshotEvent(tree: ArtifactTree): AgUiStateSnapshot {
  return { type: "STATE_SNAPSHOT", snapshot: tree.toJson() };
}

/** Retained events with seq >= sinceSeq as ONE AG-UI STATE_DELTA event (pathless
 *  pre-M7 events are skipped). Returns the delta plus the next since-cursor. */
export function deltaSince(log: EventLog, sinceSeq: number): { event: AgUiStateDelta; nextSeq: number } {
  const delta: JsonPatchOp[] = [];
  for (const e of log.since(sinceSeq)) {
    const op = toJsonPatch(e);
    if (op) delta.push(op);
  }
  return { event: { type: "STATE_DELTA", delta }, nextSeq: log.length() };
}
