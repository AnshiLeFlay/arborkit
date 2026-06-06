import type { Json } from "./types";
import type { DecomposeDecision } from "./decompose";
import type { TypeRegistry } from "./type-registry";

/** Wrap a base decision so a node's registered type can override the size heuristic. */
export function typeAwareDecision(base: DecomposeDecision, registry: TypeRegistry): DecomposeDecision {
  return {
    isOpaque(value: Json, type?: string): boolean {
      if (type !== undefined) {
        const override = registry.get(type)?.decompose;
        if (override === "opaque") return true;
        if (override === "children") return false;
      }
      return base.isOpaque(value, type);
    },
  };
}
