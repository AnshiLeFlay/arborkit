import { describe, expect, it } from "vitest";
import { centroid, cosine, dot, euclidean, norm, normalize } from "../src/vec-math";

describe("M21 vec-math", () => {
  it("computes dot products, norms, cosine, and euclidean distance", () => {
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
    expect(norm([3, 4])).toBe(5);
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 5])).toBeCloseTo(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(euclidean([0, 0], [3, 4])).toBe(5);
  });

  it("normalizes without mutating input and keeps a zero vector zero", () => {
    const input = [3, 4];
    expect(Array.from(normalize(input))).toEqual([0.6000000238418579, 0.800000011920929]);
    expect(input).toEqual([3, 4]);
    expect(Array.from(normalize([0, 0]))).toEqual([0, 0]);
  });

  it("computes a component-wise centroid and rejects invalid dimensions", () => {
    expect(centroid([[0, 0], [2, 2], [4, 4]])).toEqual([2, 2]);
    expect(() => centroid([])).toThrow("empty input");
    expect(() => centroid([[1, 2], [3]])).toThrow("same dimension");
  });
});
