import type { LabeledVector } from "./analyze";
import { cosine } from "./vec-math";

export interface SimEdge {
  a: string;
  b: string;
  weight: number;
}

export interface SimGraph {
  nodes: string[];
  edges: SimEdge[];
}

export type Digraph = Map<string, string[]>;

/** Deterministic undirected k-nearest-neighbour cosine graph. */
export function knnGraph(
  view: LabeledVector[],
  opts: { k: number; minWeight?: number },
): SimGraph {
  if (!Number.isInteger(opts.k) || opts.k <= 0) throw new Error("knnGraph(): k must be a positive integer");
  const items = [...view].sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new Error("knnGraph(): node ids must be unique");
  }
  const minWeight = opts.minWeight ?? -Infinity;
  const edges = new Map<string, SimEdge>();
  for (let index = 0; index < items.length; index++) {
    const neighbours = items
      .map((other, otherIndex) => ({
        index: otherIndex,
        weight: otherIndex === index ? -Infinity : cosine(items[index].vector, other.vector),
      }))
      .sort((a, b) => b.weight - a.weight || items[a.index].id.localeCompare(items[b.index].id))
      .slice(0, Math.min(opts.k, Math.max(0, items.length - 1)));
    for (const neighbour of neighbours) {
      if (neighbour.weight < minWeight) continue;
      const a = items[index].id < items[neighbour.index].id ? items[index].id : items[neighbour.index].id;
      const b = items[index].id < items[neighbour.index].id ? items[neighbour.index].id : items[index].id;
      edges.set(`${a}\0${b}`, { a, b, weight: neighbour.weight });
    }
  }
  return {
    nodes: items.map((item) => item.id),
    edges: [...edges.values()].sort((left, right) => left.a.localeCompare(right.a) || left.b.localeCompare(right.b)),
  };
}

/** Connected components of an undirected graph, sorted for reproducibility. */
export function connectedComponents(nodes: string[], edges: SimEdge[]): string[][] {
  const uniqueNodes = [...new Set(nodes)].sort();
  const parent = new Map(uniqueNodes.map((node) => [node, node]));
  const find = (node: string): string => {
    const current = parent.get(node);
    if (current === undefined) {
      parent.set(node, node);
      return node;
    }
    if (current === node) return node;
    const root = find(current);
    parent.set(node, root);
    return root;
  };
  for (const edge of edges) {
    const a = find(edge.a);
    const b = find(edge.b);
    if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
  }
  const groups = new Map<string, string[]>();
  for (const node of [...parent.keys()].sort()) {
    const root = find(node);
    const group = groups.get(root) ?? [];
    group.push(node);
    groups.set(root, group);
  }
  return [...groups.values()].sort((a, b) => a[0].localeCompare(b[0]));
}

function graphNodes(graph: Digraph): string[] {
  return [...new Set([...graph.keys(), ...[...graph.values()].flat()])].sort();
}

function canonicalCycle(cycle: string[]): string[] {
  let best = cycle;
  for (let index = 1; index < cycle.length; index++) {
    const rotated = [...cycle.slice(index), ...cycle.slice(0, index)];
    if (rotated.join("\0") < best.join("\0")) best = rotated;
  }
  return best;
}

/** Directed cycles as deterministic member sequences without a repeated end node. */
export function findCycles(graph: Digraph): string[][] {
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const found = new Map<string, string[]>();
  for (const node of graphNodes(graph)) color.set(node, 0);
  const visit = (node: string): void => {
    color.set(node, 1);
    stack.push(node);
    for (const next of [...(graph.get(node) ?? [])].sort()) {
      if (color.get(next) === 1) {
        const cycle = canonicalCycle(stack.slice(stack.indexOf(next)));
        found.set(cycle.join("\0"), cycle);
      } else if (color.get(next) === 0) {
        visit(next);
      }
    }
    stack.pop();
    color.set(node, 2);
  };
  for (const node of graphNodes(graph)) if (color.get(node) === 0) visit(node);
  return [...found.values()].sort((a, b) => a.join("\0").localeCompare(b.join("\0")));
}

/** Kahn topological order, or null when the graph contains a cycle. */
export function topoSort(graph: Digraph): string[] | null {
  const nodes = graphNodes(graph);
  const indegree = new Map(nodes.map((node) => [node, 0]));
  for (const targets of graph.values()) {
    for (const target of targets) indegree.set(target, (indegree.get(target) ?? 0) + 1);
  }
  const queue = nodes.filter((node) => indegree.get(node) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    order.push(node);
    for (const target of [...(graph.get(node) ?? [])].sort()) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) {
        queue.push(target);
        queue.sort();
      }
    }
  }
  return order.length === nodes.length ? order : null;
}

/** In/out degree per directed-graph node. */
export function degrees(graph: Digraph): Record<string, { in: number; out: number }> {
  const result: Record<string, { in: number; out: number }> = {};
  for (const node of graphNodes(graph)) result[node] = { in: 0, out: 0 };
  for (const [node, targets] of graph) {
    result[node].out += targets.length;
    for (const target of targets) result[target].in++;
  }
  return result;
}

/** Nodes reachable from any root via directed edges. */
export function reachable(graph: Digraph, roots: string[]): Set<string> {
  const queue = [...new Set(roots)].sort();
  const result = new Set(queue);
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const target of [...(graph.get(node) ?? [])].sort()) {
      if (result.has(target)) continue;
      result.add(target);
      queue.push(target);
    }
  }
  return result;
}

/** Members of `all` that are unreachable from the supplied roots. */
export function orphans(graph: Digraph, roots: string[], all: string[]): string[] {
  const seen = reachable(graph, roots);
  return all.filter((node) => !seen.has(node));
}
