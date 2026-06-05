import type { Json, NodeKind } from "./types";

/** Policy deciding whether a value is stored whole (opaque leaf) or split into child nodes. */
export interface DecomposeDecision {
  /** `type` is the optional registered node type (used by the by-type override in a later milestone). */
  isOpaque(value: Json, type?: string): boolean;
}

/** UTF-8 byte length of the JSON serialization of a value. */
export function byteSize(value: Json): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Structural kind of a value given whether it is being stored opaquely. */
export function kindOf(value: Json, opaque: boolean): NodeKind {
  if (opaque) return "leaf";
  return Array.isArray(value) ? "array" : "object";
}

/**
 * Default policy: scalars are always opaque leaves; containers stay opaque
 * while their serialized size is within `maxOpaqueBytes`, otherwise they split.
 */
export function sizeBasedDecision(maxOpaqueBytes: number): DecomposeDecision {
  return {
    isOpaque(value: Json): boolean {
      if (value === null || typeof value !== "object") return true;
      return byteSize(value) <= maxOpaqueBytes;
    },
  };
}
