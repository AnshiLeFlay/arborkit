import type { ArbNode, Json } from "./types";
import type { TypeDef } from "./type-registry";

/**
 * The text used to embed a node, or null if the node is not embedded.
 * A registered type's `embedText` wins; otherwise: string leaf → its value;
 * opaque object/array leaf → its JSON; numeric/boolean/null leaves and all
 * structural containers → null.
 */
export function toEmbeddingText(node: ArbNode, value: Json, typeDef?: TypeDef): string | null {
  if (typeDef?.embedText) return typeDef.embedText(value);
  if (node.kind !== "leaf") return null;
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return null;
}

/** Deterministic 32-bit FNV-1a hash, hex-encoded — used to dedupe re-embedding. */
export function textHash(text: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
}
