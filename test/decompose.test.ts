import { describe, it, expect } from "vitest";
import { byteSize, kindOf, sizeBasedDecision } from "../src/decompose";

describe("byteSize", () => {
  it("measures the UTF-8 byte length of the JSON serialization", () => {
    expect(byteSize("ab")).toBe(4); // JSON.stringify("ab") === '"ab"' => 4 bytes
  });
});

describe("kindOf", () => {
  it("returns leaf when opaque regardless of value", () => {
    expect(kindOf({ a: 1 }, true)).toBe("leaf");
  });
  it("returns array/object when not opaque", () => {
    expect(kindOf([], false)).toBe("array");
    expect(kindOf({}, false)).toBe("object");
  });

  it("returns leaf for scalars and arrays when opaque is true", () => {
    expect(kindOf(42, true)).toBe("leaf");
    expect(kindOf([1, 2], true)).toBe("leaf");
  });
});

describe("sizeBasedDecision", () => {
  const decide = sizeBasedDecision(8);

  it("treats scalars as opaque leaves", () => {
    expect(decide.isOpaque(42)).toBe(true);
    expect(decide.isOpaque("hi")).toBe(true);
    expect(decide.isOpaque(null)).toBe(true);
  });

  it("keeps a container opaque when its serialized size is within the threshold", () => {
    expect(decide.isOpaque({ a: 1 })).toBe(true); // '{"a":1}' === 7 bytes <= 8
  });

  it("splits a container that exceeds the threshold", () => {
    expect(decide.isOpaque({ a: 1, b: 2 })).toBe(false); // 13 bytes > 8
  });

  it("keeps a container opaque exactly at the threshold boundary (<=)", () => {
    // JSON.stringify({ a: 12 }) === '{"a":12}' === 8 bytes; threshold 8 => 8 <= 8 => true
    expect(sizeBasedDecision(8).isOpaque({ a: 12 })).toBe(true);
  });
});
