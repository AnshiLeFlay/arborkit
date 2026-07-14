import type { Arbor } from "./arbor";
import { isWithin } from "./jsonpointer";
import { centroid, euclidean } from "./vec-math";

// Code-unit string order: localeCompare depends on the process ICU locale and
// would break identical-input ⇒ identical-output across machines.
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A tree node projected into vector space for domain-agnostic analysis. */
export interface LabeledVector {
  id: string;
  vector: number[];
  path?: string;
  type?: string;
  tags?: string[];
}

export interface CollectVectorOptions {
  under?: string;
  type?: string;
  tag?: string;
  freshness?: "best-effort" | "wait";
}

/**
 * Materialize indexed Arbor nodes as a deterministic analysis view.
 * `freshness: "wait"` drains the semantic reindex queue first when one exists.
 */
export async function collectVectors(
  arbor: Arbor,
  opts: CollectVectorOptions = {},
): Promise<LabeledVector[]> {
  if (opts.freshness === "wait") await arbor.index?.reindex();
  const result: LabeledVector[] = [];
  for (const entry of await arbor.vectors.entries()) {
    const node = arbor.tree.get(entry.nodeId);
    if (!node) continue;
    const path = arbor.addressing.pathOf(entry.nodeId);
    if (!isWithin(path, opts.under)) continue;
    if (opts.type !== undefined && node.type !== opts.type) continue;
    if (opts.tag !== undefined && !(node.tags?.includes(opts.tag) ?? false)) continue;
    result.push({
      id: entry.nodeId,
      vector: [...entry.vector],
      path,
      type: node.type,
      tags: node.tags === undefined ? undefined : [...node.tags],
    });
  }
  result.sort((a, b) => byCodeUnit(a.path ?? "", b.path ?? "") || byCodeUnit(a.id, b.id));
  return result;
}

export interface ClusterResult {
  k: number;
  assignments: number[];
  centroids: number[][];
  inertia: number;
}

export interface KmeansOptions {
  k: number;
  seed?: number;
  maxIters?: number;
}

function lcg(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function assertCompatible(items: LabeledVector[]): void {
  if (items.length === 0) return;
  const dimension = items[0].vector.length;
  if (items.some((item) => item.vector.length !== dimension)) {
    throw new Error("analysis vectors must all have the same dimension");
  }
}

/** Seeded k-means++ returning partitions and metrics, never a quality verdict. */
export function kmeans(items: LabeledVector[], opts: KmeansOptions): ClusterResult {
  if (!Number.isInteger(opts.k) || opts.k <= 0) throw new Error("kmeans(): k must be a positive integer");
  const maxIters = opts.maxIters ?? 50;
  if (!Number.isInteger(maxIters) || maxIters <= 0) {
    throw new Error("kmeans(): maxIters must be a positive integer");
  }
  if (items.length === 0) return { k: 0, assignments: [], centroids: [], inertia: 0 };
  assertCompatible(items);

  const points = items.map((item) => item.vector);
  const effectiveK = Math.min(opts.k, points.length);
  const random = lcg(opts.seed ?? 1);
  const chosen = new Set<number>();
  const first = Math.floor(random() * points.length);
  chosen.add(first);
  const centers: number[][] = [[...points[first]]];

  while (centers.length < effectiveK) {
    const squaredDistances = points.map((point) =>
      Math.min(...centers.map((center) => euclidean(point, center) ** 2)),
    );
    const total = squaredDistances.reduce((sum, distance) => sum + distance, 0);
    let selected = -1;
    if (total > 0) {
      let cursor = random() * total;
      for (let index = 0; index < squaredDistances.length; index++) {
        cursor -= squaredDistances[index];
        if (cursor <= 0) {
          selected = index;
          break;
        }
      }
    }
    if (selected < 0 || chosen.has(selected)) {
      selected = points.findIndex((_, index) => !chosen.has(index));
    }
    chosen.add(selected);
    centers.push([...points[selected]]);
  }

  let assignments = new Array<number>(points.length).fill(-1);
  for (let iteration = 0; iteration < maxIters; iteration++) {
    const next = points.map((point) => {
      let bestCluster = 0;
      let bestDistance = Infinity;
      for (let cluster = 0; cluster < centers.length; cluster++) {
        const distance = euclidean(point, centers[cluster]);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestCluster = cluster;
        }
      }
      return bestCluster;
    });
    const stable = next.every((cluster, index) => cluster === assignments[index]);
    assignments = next;
    for (let cluster = 0; cluster < centers.length; cluster++) {
      const members = points.filter((_, index) => assignments[index] === cluster);
      if (members.length > 0) centers[cluster] = centroid(members);
    }
    if (stable) break;
  }

  const inertia = points.reduce(
    (sum, point, index) => sum + euclidean(point, centers[assignments[index]]) ** 2,
    0,
  );
  return { k: effectiveK, assignments, centroids: centers, inertia };
}

export interface OutlierScore {
  id: string;
  score: number;
}

/** Distance from each item to the supplied or global centroid. */
export function outlierScores(items: LabeledVector[], reference?: number[]): OutlierScore[] {
  if (items.length === 0) return [];
  assertCompatible(items);
  const center = reference ?? centroid(items.map((item) => item.vector));
  return items.map((item) => ({ id: item.id, score: euclidean(item.vector, center) }));
}

/** Mean distance to the k nearest neighbours; higher means more locally isolated. */
export function localOutlierScores(
  items: LabeledVector[],
  opts: { k?: number } = {},
): OutlierScore[] {
  assertCompatible(items);
  if (items.length <= 1) return items.map((item) => ({ id: item.id, score: 0 }));
  const requested = opts.k ?? Math.min(5, items.length - 1);
  if (!Number.isInteger(requested) || requested <= 0) {
    throw new Error("localOutlierScores(): k must be a positive integer");
  }
  const k = Math.min(requested, items.length - 1);
  return items.map((item, itemIndex) => {
    const distances = items
      .map((other, otherIndex) => otherIndex === itemIndex ? Infinity : euclidean(item.vector, other.vector))
      .sort((a, b) => a - b)
      .slice(0, k);
    return { id: item.id, score: distances.reduce((sum, distance) => sum + distance, 0) / distances.length };
  });
}

export interface SilhouetteResult {
  perItem: Array<{ id: string; score: number }>;
  mean: number;
}

/** Per-item and mean silhouette score in [-1, 1]. Singleton clusters score zero. */
export function silhouette(items: LabeledVector[], assignments: number[]): SilhouetteResult {
  if (assignments.length !== items.length) {
    throw new Error("silhouette(): assignments length must equal item count");
  }
  assertCompatible(items);
  const perItem = items.map((item, itemIndex) => {
    const ownCluster = assignments[itemIndex];
    const same: number[] = [];
    const otherClusters = new Map<number, number[]>();
    for (let otherIndex = 0; otherIndex < items.length; otherIndex++) {
      if (otherIndex === itemIndex) continue;
      const distance = euclidean(item.vector, items[otherIndex].vector);
      const cluster = assignments[otherIndex];
      if (cluster === ownCluster) {
        same.push(distance);
      } else {
        const values = otherClusters.get(cluster) ?? [];
        values.push(distance);
        otherClusters.set(cluster, values);
      }
    }
    if (same.length === 0 || otherClusters.size === 0) return { id: item.id, score: 0 };
    const within = same.reduce((sum, distance) => sum + distance, 0) / same.length;
    let nearestOther = Infinity;
    for (const distances of otherClusters.values()) {
      const mean = distances.reduce((sum, distance) => sum + distance, 0) / distances.length;
      nearestOther = Math.min(nearestOther, mean);
    }
    const denominator = Math.max(within, nearestOther);
    return { id: item.id, score: denominator === 0 ? 0 : (nearestOther - within) / denominator };
  });
  const mean = perItem.length === 0
    ? 0
    : perItem.reduce((sum, item) => sum + item.score, 0) / perItem.length;
  return { perItem, mean };
}

/** Assign each item to the nearest caller-labelled centroid. */
export function classifyNearest(
  items: LabeledVector[],
  labelled: Array<{ label: string; vector: number[] }>,
): Array<{ id: string; label: string }> {
  if (labelled.length === 0) throw new Error("classifyNearest(): at least one labelled centroid is required");
  return items.map((item) => {
    let best = labelled[0];
    let bestDistance = euclidean(item.vector, best.vector);
    for (let index = 1; index < labelled.length; index++) {
      const distance = euclidean(item.vector, labelled[index].vector);
      if (distance < bestDistance) {
        best = labelled[index];
        bestDistance = distance;
      }
    }
    return { id: item.id, label: best.label };
  });
}

export interface ScoreDiff {
  added: string[];
  removed: string[];
  changed: Array<{ id: string; from: number; to: number; delta: number }>;
}

/** Diff two per-id numeric maps without assigning regression semantics. */
export function compareScores(prev: Record<string, number>, next: Record<string, number>): ScoreDiff {
  const added = Object.keys(next).filter((id) => !(id in prev)).sort();
  const removed = Object.keys(prev).filter((id) => !(id in next)).sort();
  const changed = Object.keys(prev)
    .filter((id) => id in next && next[id] !== prev[id])
    .sort()
    .map((id) => ({ id, from: prev[id], to: next[id], delta: next[id] - prev[id] }));
  return { added, removed, changed };
}
