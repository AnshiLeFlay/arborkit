import { describe, expect, it } from "vitest";
import {
  connectedComponents,
  degrees,
  findCycles,
  knnGraph,
  orphans,
  reachable,
  topoSort,
} from "../src/analyze-graph";

describe("M21 similarity graphs", () => {
  it("links nearest neighbours and returns deterministic connected components", () => {
    const view = [
      { id: "a", vector: [1, 0] },
      { id: "b", vector: [1, 0.01] },
      { id: "c", vector: [-1, 0] },
      { id: "d", vector: [-1, -0.01] },
    ];
    const graph = knnGraph(view, { k: 1, minWeight: 0.9 });
    expect(connectedComponents(graph.nodes, graph.edges)).toEqual([["a", "b"], ["c", "d"]]);
    expect(graph.edges.every((edge) => edge.a < edge.b)).toBe(true);
  });

  it("keeps zero-vector nodes without manufacturing similarity edges", () => {
    const graph = knnGraph([
      { id: "zero", vector: [0, 0] },
      { id: "one", vector: [1, 0] },
    ], { k: 1, minWeight: 0.1 });
    expect(graph).toEqual({ nodes: ["one", "zero"], edges: [] });
  });
});

describe("M21 graph determinism hardening", () => {
  it("orders ids by code units, independent of the process locale", () => {
    const graph = knnGraph([
      { id: "a", vector: [1, 0] },
      { id: "B", vector: [1, 0.01] },
    ], { k: 1 });
    // "B" (0x42) sorts before "a" (0x61); locale-aware collation flips this
    expect(graph.nodes).toEqual(["B", "a"]);
    expect(graph.edges.map((edge) => [edge.a, edge.b])).toEqual([["B", "a"]]);
  });

  it("rejects mixed vector dimensions", () => {
    expect(() =>
      knnGraph([
        { id: "a", vector: [1, 0] },
        { id: "b", vector: [1, 0, 0] },
      ], { k: 1 }),
    ).toThrow("same dimension");
  });

  it("drops NaN-weight edges instead of letting them into the graph", () => {
    const graph = knnGraph([
      { id: "a", vector: [1, 0] },
      { id: "b", vector: [0.9, 0.1] },
      { id: "broken", vector: [Number.NaN, 0] },
    ], { k: 2 });
    expect(graph.nodes).toEqual(["a", "b", "broken"]);
    expect(graph.edges.map((edge) => [edge.a, edge.b])).toEqual([["a", "b"]]);
    expect(graph.edges.every((edge) => Number.isFinite(edge.weight))).toBe(true);
  });
});

describe("M21 directed graph algorithms", () => {
  it("finds cycles, degrees, topological order, reachability, and orphans", () => {
    expect(findCycles(new Map([["a", ["b"]], ["b", ["c"]], ["c", ["a"]]]))).toEqual([["a", "b", "c"]]);
    expect(topoSort(new Map([["a", ["b"]], ["b", ["c"]], ["c", []]]))).toEqual(["a", "b", "c"]);
    expect(topoSort(new Map([["a", ["b"]], ["b", ["a"]]]))).toBeNull();
    expect(degrees(new Map([["a", ["b", "c"]], ["b", []], ["c", []]]))).toEqual({
      a: { in: 0, out: 2 },
      b: { in: 1, out: 0 },
      c: { in: 1, out: 0 },
    });
    const graph = new Map([["home", ["a"]], ["a", []], ["orphan", []]]);
    expect([...reachable(graph, ["home"])]).toEqual(["home", "a"]);
    expect(orphans(graph, ["home"], ["orphan", "a", "home"])).toEqual(["orphan"]);
  });
});
