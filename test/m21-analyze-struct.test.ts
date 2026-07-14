import { describe, expect, it } from "vitest";
import {
  canonicalize,
  jaccard,
  minhashSignature,
  minhashSimilarity,
  shapeTokens,
  structuralHash,
} from "../src/analyze-struct";

describe("M21 structural analytics", () => {
  it("canonicalizes object key order and hashes exact normalized JSON", () => {
    expect(canonicalize({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
    expect(structuralHash({ a: 1, b: 2 })).toBe(structuralHash({ b: 2, a: 1 }));
    expect(structuralHash({ items: [1, 2] })).not.toBe(structuralHash({ items: [1, 2, 3] }));
  });

  it('treats "__proto__" as an ordinary data key', () => {
    // JSON.parse: an object literal with a "__proto__" key would set the
    // prototype instead of creating an own property.
    const withProto = JSON.parse('{"a":{"__proto__":{"x":1}}}');
    expect(canonicalize(withProto)).toBe('{"a":{"__proto__":{"x":1}}}');
    expect(structuralHash(withProto)).not.toBe(structuralHash({ a: {} }));
  });

  it("compares shapes while ignoring leaf values", () => {
    const four = { nav: [{ t: "A" }, { t: "B" }, { t: "C" }, { t: "D" }] };
    const renamed = { nav: [{ t: "W" }, { t: "X" }, { t: "Y" }, { t: "Z" }] };
    const five = { nav: [{ t: "A" }, { t: "B" }, { t: "C" }, { t: "D" }, { t: "E" }] };
    expect(jaccard(shapeTokens(four), shapeTokens(renamed))).toBe(1);
    expect(jaccard(shapeTokens(four), shapeTokens(five))).toBeLessThan(1);
    expect(jaccard(new Set(), new Set())).toBe(1);
  });

  it("produces deterministic MinHash signatures that approximate Jaccard", () => {
    const left = shapeTokens({ nav: [{ t: 1 }, { t: 2 }, { t: 3 }, { t: 4 }] });
    const right = shapeTokens({ nav: [{ t: 1 }, { t: 2 }, { t: 3 }] });
    const a = minhashSignature(left, { numHashes: 256, seed: 11 });
    const b = minhashSignature(right, { numHashes: 256, seed: 11 });
    expect(minhashSignature(left, { numHashes: 256, seed: 11 })).toEqual(a);
    expect(Math.abs(minhashSimilarity(a, b) - jaccard(left, right))).toBeLessThan(0.15);
  });
});
