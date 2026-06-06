import { describe, it, expect } from "vitest";
import { TypeRegistry } from "../src/type-registry";
import { typeAwareDecision } from "../src/type-aware-decision";
import { sizeBasedDecision } from "../src/decompose";

describe("typeAwareDecision", () => {
  const registry = new TypeRegistry();
  registry.register("Opaque", { decompose: "opaque" });
  registry.register("Children", { decompose: "children" });
  const decision = typeAwareDecision(sizeBasedDecision(1_000_000), registry);

  it("forces opaque for a type with decompose 'opaque' (even when size would split)", () => {
    const tiny = typeAwareDecision(sizeBasedDecision(2), registry);
    expect(tiny.isOpaque({ a: 1, b: 2, c: 3 }, "Opaque")).toBe(true);
  });

  it("forces children for a type with decompose 'children' (even when size would keep opaque)", () => {
    expect(decision.isOpaque({ a: 1 }, "Children")).toBe(false);
  });

  it("falls back to the base decision when the type has no override", () => {
    registry.register("Plain", {});
    expect(decision.isOpaque({ a: 1 }, "Plain")).toBe(true);
    expect(decision.isOpaque({ a: 1 })).toBe(true);
  });

  it("falls back to the base decision for an unregistered type", () => {
    expect(decision.isOpaque({ a: 1 }, "Unknown")).toBe(true);
  });
});
