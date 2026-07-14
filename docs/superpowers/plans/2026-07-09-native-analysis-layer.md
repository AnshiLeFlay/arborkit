# arborkit native analysis layer (`arborkit/analyze`) — Implementation Plan

> **M21 adaptation (2026-07-14):** implementation starts from ArborKit 1.3.0
> after the complete M20 Agent Bridge and targets 1.4.0. Analysis definitions
> use M20 input + output schemas, `reader`/`editor`/`admin` profile parity,
> `under`/`type`/`tag`/`freshness` filters, async guards, and result caps. The
> read-only analysis executor remains separate from the scoped mutation
> executor because it requires the full `Arbor` vector/tree view. The current
> user-directed workflow supersedes the older branch and per-task commit notes.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a native, domain-agnostic analysis layer to arborkit that turns the tree's existing vectors + structure into reusable analytics — clustering, cluster-quality (silhouette), global & local (kNN) outlier scoring, nearest-centroid classification, STRUCTURAL similarity (subtree hashing + Jaccard/MinHash), and similarity/directed graphs with graph algorithms (components, cycles, topo-sort, reachability/orphans) — plus an LLM-usable tool bridge, so an agent can run `read → analyze → fix` on the shared tree.

**Architecture:** Everything rides on seams arborkit already owns: `VectorIndexPort.entries()` (raw per-node vectors), `SemanticIndex` (embeddings), `ArtifactTree.toJson`/`get` + `Addressing.pathOf` (node structure & metadata). Split into pure math (`vec-math`), vector analytics (`analyze`), structural analytics (`analyze-struct`), graph (`analyze-graph`), and an agent bridge (`analyze-tools`) mirroring the existing `agent-tools` never-throw JSON pattern. The layer covers BOTH failure modes the consumer observed: menu inconsistency is **structural** (served by `analyze-struct`), topic drift is **semantic-local** (served by local/kNN outliers + silhouette, not naive global-centroid distance which false-positives on legitimately multi-topic sites). **Hard invariant: every function returns numbers and structures (assignments, distances, scores, hashes, token-sets, clusters, graphs, components) — NEVER a verdict, label, or threshold.** "This cluster is bad / distance > 0.4 = drift / these headers are inconsistent / this is a casino page" is domain interpretation and lives in the consuming app, not here.

**Tech Stack:** TypeScript, ESM, Node ≥20.6, vitest, tsup. **Zero runtime dependencies** (pure math + a non-crypto string hash, no libs). New public subpaths under `arborkit/*`.

**Repo / release:** `c:\code\tools\arbor` (package `arborkit`, github `AnshiLeFlay/arborkit`). **Do NOT push and do NOT `npm publish`** — both are the user's manual action. This is a `1.3.0 → 1.4.0` minor (additive).

---

## Global Constraints

- **Verdict-free invariant (the governing rule):** functions in `vec-math`, `analyze`, `analyze-struct`, `analyze-graph` return metrics/structures only. No function may return a boolean "pass/fail", a domain label string, or embed a "good/acceptable" threshold constant. Thresholds/labels are always caller-supplied parameters, never baked in. A reviewer finding of a hardcoded verdict/threshold is a spec violation. (`outlierScores`/`localOutlierScores` return distances, NOT an `isOutlier` flag; `structuralHash` returns a hash, NOT `isConsistent`; `silhouette` returns a score, NOT `isFragmented`.)
- **Determinism:** all analytics are reproducible. No `Math.random`, no `Date.now`. k-means uses a caller-seeded deterministic init (default seed `1`); MinHash uses seeded deterministic permutations (default seed `1`). Identical input + seed ⇒ identical output. This matters because the layer is an eval/regression substrate.
- **Zero runtime deps preserved.** Pure math + a small non-cryptographic hash (`cyrb53`) implemented inline — no `crypto`/hashing lib.
- **Non-invasive to the hot path.** Do not change `SemanticIndex` mutation/reindex logic or `Mutator`. The layer only READS (`vectors.entries()`, `tree.toJson`, `tree.get`, `addressing.pathOf`). The one allowed edit to an existing file is refactoring the private `normalize`/`dot` in `vector-index-port.ts` to import from the new `vec-math` (pure fns, no `instanceof`/packaging impact) — optional, see Task 1.
- **Packaging parity:** every new module gets an explicit `package.json` exports entry and a barrel re-export, and is added to the packaging regression test (the m11 test that pins the exports map). `splitting: true` in tsup must stay on.
- Tests green (`npm test`, baseline 409), `npm run typecheck` clean, `npm run build` clean.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/vec-math.ts` | pure vector math: `normalize`, `dot`, `norm`, `cosine`, `euclidean`, `centroid` | **create** |
| `src/analyze.ts` | vector analytics over `LabeledVector[]`: `collectVectors`, `kmeans` (seeded), `outlierScores` (global), `localOutlierScores` (kNN), `silhouette`, `classifyNearest`, `compareScores` | **create** |
| `src/analyze-struct.ts` | structural analytics on JSON subtrees: `canonicalize`, `hashString`, `structuralHash`, `shapeTokens`, `jaccard`, `minhashSignature`, `minhashSimilarity` | **create** |
| `src/analyze-graph.ts` | `knnGraph`, `Digraph`, `connectedComponents`, `findCycles`, `topoSort`, `degrees`, `reachable`, `orphans` | **create** |
| `src/analyze-tools.ts` | `analyzeToolDefs()` + `makeAnalyzeExecutor(arbor)` — never-throw JSON LLM tool bridge | **create** |
| `src/vector-index-port.ts` | (optional) import `normalize`/`dot` from `vec-math` to avoid duplication | modify |
| `src/index.ts` | barrel re-export the 5 new modules | modify |
| `package.json` | add 5 subpath exports; bump `1.3.0`→`1.4.0` | modify |
| `CHANGELOG.md` | 1.4.0 entry | modify |
| `test/*` | one test file per module | create |
| the m11 packaging test | add the 5 new subpaths to the pinned exports assertion | modify |

Shared data contract:
```ts
// A node projected into vector space for analysis. `id` is a NodeId; meta optional
// so the math is testable with bare vectors and no Arbor.
export interface LabeledVector { id: string; vector: number[]; path?: string; type?: string; tags?: string[]; }
```

**Algorithm inventory (what this plan implements):** k-means (+k-means++ seeding +LCG PRNG), silhouette, global-centroid outlier, kNN-local outlier, nearest-centroid classification, subtree structural hashing (canonical-JSON + cyrb53), shape-token extraction, Jaccard, MinHash signature + similarity, k-NN similarity graph, connected components (union-find), directed cycle detection (DFS colouring), Kahn topo-sort, graph reachability (BFS) + orphan detection. Vector primitives (dot/norm/normalize/cosine/euclidean/centroid) underpin them.

---

## Task 1 — `vec-math`: pure vector math

**Files:** Create `src/vec-math.ts`, `test/vec-math.test.ts`. Optionally modify `src/vector-index-port.ts`.

- [ ] **Step 1: Write the failing test** (`test/vec-math.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { cosine, euclidean, centroid } from "../src/vec-math";

describe("vec-math", () => {
  it("cosine: identical dirs → 1, orthogonal → 0, zero-vec → 0", () => {
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 5])).toBeCloseTo(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
  it("euclidean distance", () => { expect(euclidean([0, 0], [3, 4])).toBeCloseTo(5); });
  it("centroid is componentwise mean; empty throws", () => {
    expect(centroid([[0, 0], [2, 2], [4, 4]])).toEqual([2, 2]);
    expect(() => centroid([])).toThrow();
  });
});
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run test/vec-math.test.ts` → module not found.

- [ ] **Step 3: Create `src/vec-math.ts`**

```ts
// Pure vector math — zero deps, no state. Shared by the vector index and the
// analysis layer. Ragged lengths use the shorter length (matches the index).

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const len = Math.min(a.length, b.length);
  let d = 0;
  for (let i = 0; i < len; i++) d += a[i] * b[i];
  return d;
}
export function norm(v: ArrayLike<number>): number {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  return Math.sqrt(n);
}
/** Unit-normalize; a zero vector stays all-zeros (its cosine with anything is 0). */
export function normalize(v: ArrayLike<number>): Float32Array {
  const out = new Float32Array(v.length);
  const n = norm(v);
  if (n === 0) return out;
  const inv = 1 / n;
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv;
  return out;
}
/** Cosine similarity in [-1,1]; 0 when either side has zero magnitude. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const na = norm(a), nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}
export function euclidean(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const len = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < len; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}
/** Componentwise mean. Throws on empty — the caller decides what an empty set means. */
export function centroid(vectors: ReadonlyArray<ArrayLike<number>>): number[] {
  if (vectors.length === 0) throw new Error("centroid(): empty input");
  const dim = vectors[0].length;
  const out = new Array<number>(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) out[i] += v[i];
  for (let i = 0; i < dim; i++) out[i] /= vectors.length;
  return out;
}
```

- [ ] **Step 4 (optional, DRY): refactor `src/vector-index-port.ts`** to `import { normalize, dot } from "./vec-math"` and delete its private copies (lines 26-41). Pure fns → no packaging/`instanceof` impact. If the implementer judges the risk to the stable hot path not worth it, SKIP entirely (do not partially refactor).

- [ ] **Step 5: Run tests** — PASS (+ vector-index suite if refactored).
- [ ] **Step 6: Commit** — `feat(analyze): vec-math pure vector helpers`

---

## Task 2 — `analyze` core: clustering, global outlier, classification, score diff

**Files:** Create `src/analyze.ts` (core portion), `test/analyze.test.ts`.

- [ ] **Step 1: Write the failing test** (`test/analyze.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { kmeans, outlierScores, classifyNearest, compareScores } from "../src/analyze";

const A = { id: "a", vector: [0, 0] }, B = { id: "b", vector: [0.1, 0] };
const C = { id: "c", vector: [10, 10] }, D = { id: "d", vector: [10.1, 10] };

describe("kmeans", () => {
  it("separates two blobs, deterministically", () => {
    const r1 = kmeans([A, B, C, D], { k: 2, seed: 1 });
    const r2 = kmeans([A, B, C, D], { k: 2, seed: 1 });
    expect(r1.assignments).toEqual(r2.assignments);
    expect(r1.assignments[0]).toBe(r1.assignments[1]);
    expect(r1.assignments[2]).toBe(r1.assignments[3]);
    expect(r1.assignments[0]).not.toBe(r1.assignments[2]);
  });
});
describe("outlierScores", () => {
  it("ranks the far point highest vs the global centroid", () => {
    const byId = Object.fromEntries(outlierScores([A, B, C]).map((s) => [s.id, s.score]));
    expect(byId["c"]).toBeGreaterThan(byId["a"]);
  });
});
describe("classifyNearest", () => {
  it("assigns to the nearest labelled centroid", () => {
    const labels = [{ label: "L", vector: [0, 0] }, { label: "R", vector: [10, 10] }];
    expect(classifyNearest([A, D], labels)).toEqual([{ id: "a", label: "L" }, { id: "d", label: "R" }]);
  });
});
describe("compareScores", () => {
  it("diffs two per-id maps", () => {
    const d = compareScores({ a: 1, b: 2 }, { b: 5, c: 3 });
    expect(d.removed).toEqual(["a"]); expect(d.added).toEqual(["c"]);
    expect(d.changed).toEqual([{ id: "b", from: 2, to: 5, delta: 3 }]);
  });
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Create `src/analyze.ts`** (core; local/quality fns added in Task 3, `collectVectors` in Task 4):

```ts
import { euclidean, centroid } from "./vec-math";

export interface LabeledVector { id: string; vector: number[]; path?: string; type?: string; tags?: string[]; }
export interface ClusterResult { k: number; assignments: number[]; centroids: number[][]; inertia: number; }
export interface OutlierScore { id: string; score: number; }

// Deterministic PRNG (LCG) — reproducible k-means++ init without Math.random.
function lcg(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

/** k-means with seeded k-means++ init. Deterministic for (input, k, seed). Returns
 *  the partition + inertia; never a "good/bad". */
export function kmeans(items: LabeledVector[], opts: { k: number; seed?: number; maxIters?: number }): ClusterResult {
  const { k } = opts;
  const rnd = lcg(opts.seed ?? 1);
  const maxIters = opts.maxIters ?? 50;
  const pts = items.map((it) => it.vector);
  if (k <= 0 || pts.length === 0) return { k, assignments: [], centroids: [], inertia: 0 };
  const kEff = Math.min(k, pts.length);
  const centroids: number[][] = [pts[Math.floor(rnd() * pts.length)].slice()];
  while (centroids.length < kEff) {
    const d2 = pts.map((p) => Math.min(...centroids.map((c) => euclidean(p, c) ** 2)));
    const sum = d2.reduce((a, b) => a + b, 0) || 1;
    let r = rnd() * sum, idx = 0;
    for (; idx < d2.length; idx++) { r -= d2[idx]; if (r <= 0) break; }
    centroids.push(pts[Math.min(idx, pts.length - 1)].slice());
  }
  const assignments = new Array<number>(pts.length).fill(0);
  for (let iter = 0; iter < maxIters; iter++) {
    let moved = false;
    for (let i = 0; i < pts.length; i++) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) { const dd = euclidean(pts[i], centroids[c]); if (dd < bestD) { bestD = dd; best = c; } }
      if (assignments[i] !== best) { assignments[i] = best; moved = true; }
    }
    for (let c = 0; c < centroids.length; c++) {
      const members = pts.filter((_, i) => assignments[i] === c);
      if (members.length > 0) centroids[c] = centroid(members);
    }
    if (!moved) break;
  }
  let inertia = 0;
  for (let i = 0; i < pts.length; i++) inertia += euclidean(pts[i], centroids[assignments[i]]) ** 2;
  return { k: kEff, assignments, centroids, inertia };
}

/** Distance from each vector to a reference centroid (default: global centroid).
 *  GLOBAL measure — for legitimately multi-cluster data prefer localOutlierScores. */
export function outlierScores(items: LabeledVector[], reference?: number[]): OutlierScore[] {
  if (items.length === 0) return [];
  const ref = reference ?? centroid(items.map((i) => i.vector));
  return items.map((it) => ({ id: it.id, score: euclidean(it.vector, ref) }));
}

/** Nearest labelled centroid. Mechanism only — labels are the caller's domain data. */
export function classifyNearest(items: LabeledVector[], labelled: { label: string; vector: number[] }[]): { id: string; label: string }[] {
  return items.map((it) => {
    let best = labelled[0]?.label ?? "", bestD = Infinity;
    for (const l of labelled) { const d = euclidean(it.vector, l.vector); if (d < bestD) { bestD = d; best = l.label; } }
    return { id: it.id, label: best };
  });
}

export interface ScoreDiff { added: string[]; removed: string[]; changed: { id: string; from: number; to: number; delta: number }[]; }
/** Diff two per-id numeric maps (e.g. scores of two runs/versions). Reports deltas,
 *  not regressions — the caller judges direction. */
export function compareScores(prev: Record<string, number>, next: Record<string, number>): ScoreDiff {
  const added: string[] = [], removed: string[] = [], changed: ScoreDiff["changed"] = [];
  for (const id of Object.keys(next)) if (!(id in prev)) added.push(id);
  for (const id of Object.keys(prev)) {
    if (!(id in next)) { removed.push(id); continue; }
    if (next[id] !== prev[id]) changed.push({ id, from: prev[id], to: next[id], delta: next[id] - prev[id] });
  }
  return { added, removed, changed };
}
```

- [ ] **Step 4: Run tests** — PASS.
- [ ] **Step 5: Commit** — `feat(analyze): seeded kmeans, global outlier, nearest-centroid classify, score diff`

---

## Task 3 — `analyze` local outlier + silhouette

**Files:** Modify `src/analyze.ts` (add functions), `test/analyze-local.test.ts`.

These serve topic-drift on legitimately multi-topic sites, where global-centroid distance false-positives. `localOutlierScores` = mean distance to k nearest neighbours (kNN-distance variant — simpler & deterministic than full LOF, sufficient here). `silhouette` = cluster cohesion quantifier.

- [ ] **Step 1: Write the failing test** (`test/analyze-local.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { localOutlierScores, silhouette, kmeans } from "../src/analyze";

describe("localOutlierScores", () => {
  it("flags a point isolated from its local neighbours, not just far from global mean", () => {
    // two tight blobs + one lone point between them: global-centroid would rank
    // blob members oddly; local score isolates the lone point.
    const items = [
      { id: "a", vector: [0, 0] }, { id: "b", vector: [0.1, 0] }, { id: "c", vector: [0, 0.1] },
      { id: "x", vector: [5, 5] }, // lone
      { id: "d", vector: [10, 10] }, { id: "e", vector: [10.1, 10] }, { id: "f", vector: [10, 10.1] },
    ];
    const byId = Object.fromEntries(localOutlierScores(items, { k: 2 }).map((s) => [s.id, s.score]));
    expect(byId["x"]).toBeGreaterThan(byId["a"]);
    expect(byId["x"]).toBeGreaterThan(byId["d"]);
  });
});
describe("silhouette", () => {
  it("well-separated clusters score near 1; mean in [-1,1]", () => {
    const items = [{ id: "a", vector: [0, 0] }, { id: "b", vector: [0.1, 0] }, { id: "c", vector: [10, 10] }, { id: "d", vector: [10.1, 10] }];
    const cl = kmeans(items, { k: 2, seed: 1 });
    const s = silhouette(items, cl.assignments);
    expect(s.mean).toBeGreaterThan(0.8);
    expect(s.perItem).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Add to `src/analyze.ts`**

```ts
/** Local outlier score = mean distance to the k nearest neighbours (kNN-distance
 *  variant; deterministic, simpler than full LOF). Higher = more isolated from its
 *  LOCAL neighbourhood — robust when the data legitimately has several clusters. */
export function localOutlierScores(items: LabeledVector[], opts: { k?: number } = {}): OutlierScore[] {
  const k = opts.k ?? Math.min(5, Math.max(1, items.length - 1));
  return items.map((it, i) => {
    const dists = items.map((o, j) => (i === j ? Infinity : euclidean(it.vector, o.vector)))
      .sort((a, b) => a - b).slice(0, k).filter((d) => Number.isFinite(d));
    return { id: it.id, score: dists.length ? dists.reduce((a, b) => a + b, 0) / dists.length : 0 };
  });
}

export interface SilhouetteResult { perItem: { id: string; score: number }[]; mean: number; }
/** Silhouette per item + mean over a clustering. s = (b − a) / max(a, b): a = mean
 *  intra-cluster distance, b = min mean distance to another cluster. In [-1,1]. A
 *  pure quality metric — the caller decides what value is "too fragmented". */
export function silhouette(items: LabeledVector[], assignments: number[]): SilhouetteResult {
  const perItem = items.map((it, i) => {
    const same: number[] = []; const byCluster = new Map<number, number[]>();
    for (let j = 0; j < items.length; j++) {
      if (j === i) continue;
      const d = euclidean(it.vector, items[j].vector);
      if (assignments[j] === assignments[i]) same.push(d);
      else { const arr = byCluster.get(assignments[j]) ?? []; arr.push(d); byCluster.set(assignments[j], arr); }
    }
    const a = same.length ? same.reduce((x, y) => x + y, 0) / same.length : 0;
    let b = Infinity;
    for (const [, arr] of byCluster) { const m = arr.reduce((x, y) => x + y, 0) / arr.length; if (m < b) b = m; }
    const s = !Number.isFinite(b) || Math.max(a, b) === 0 ? 0 : (b - a) / Math.max(a, b);
    return { id: it.id, score: s };
  });
  const mean = perItem.length ? perItem.reduce((x, y) => x + y.score, 0) / perItem.length : 0;
  return { perItem, mean };
}
```

- [ ] **Step 4: Run tests** — PASS.
- [ ] **Step 5: Commit** — `feat(analyze): kNN-local outlier + silhouette`

---

## Task 4 — `collectVectors`: Arbor → `LabeledVector[]` adapter

**Files:** Modify `src/analyze.ts`, Test `test/analyze-collect.test.ts`.

- [ ] **Step 1: Write the failing test** (`test/analyze-collect.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { createArbor } from "../src/arbor";
import { MockEmbeddingPort } from "../src/embedding-port";
import { sizeBasedDecision } from "../src/decompose";
import { collectVectors } from "../src/analyze";

describe("collectVectors", () => {
  it("returns a LabeledVector per indexed node with path/type", async () => {
    const arbor = createArbor({ initial: { a: "alpha text", b: "beta text" }, embedding: new MockEmbeddingPort(), decompose: sizeBasedDecision(1) });
    await arbor.index!.reindex();
    const view = await collectVectors(arbor);
    expect(view.length).toBeGreaterThan(0);
    expect(view.every((v) => Array.isArray(v.vector) && v.vector.length > 0 && typeof v.path === "string")).toBe(true);
  });
  it("filters by `under`", async () => {
    const arbor = createArbor({ initial: { keep: { x: "one" }, drop: { y: "two" } }, embedding: new MockEmbeddingPort(), decompose: sizeBasedDecision(1) });
    await arbor.index!.reindex();
    expect((await collectVectors(arbor, { under: "/keep" })).every((v) => v.path!.startsWith("/keep"))).toBe(true);
  });
});
```
(Implementer: confirm `MockEmbeddingPort` export name in `embedding-port.ts`; the README references it.)

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Add to `src/analyze.ts`**

```ts
import type { Arbor } from "./arbor";
import { isWithin } from "./jsonpointer";

/** Project currently-indexed nodes into analysis space (raw vectors + path/type/tags).
 *  Only indexed nodes are returned — call arbor.index.reindex() first for freshness.
 *  Optional under/type filters mirror search. */
export async function collectVectors(arbor: Arbor, opts: { under?: string; type?: string } = {}): Promise<LabeledVector[]> {
  const entries = await arbor.vectors.entries();
  const out: LabeledVector[] = [];
  for (const e of entries) {
    const node = arbor.tree.get(e.nodeId);
    if (!node) continue;
    const path = arbor.addressing.pathOf(e.nodeId);
    if (opts.under !== undefined && !isWithin(path, opts.under)) continue;
    if (opts.type !== undefined && node.type !== opts.type) continue;
    out.push({ id: e.nodeId, vector: e.vector, path, type: node.type, tags: node.tags });
  }
  return out;
}
```

- [ ] **Step 4: Run tests** — PASS.
- [ ] **Step 5: Commit** — `feat(analyze): collectVectors adapter (tree → analysis view)`

---

## Task 5 — `analyze-struct`: structural hashing + Jaccard/MinHash

**Files:** Create `src/analyze-struct.ts`, `test/analyze-struct.test.ts`.

Serves the STRUCTURAL failure mode (menu inconsistency) that vector cosine can't see crisply: `structuralHash` gives exact subtree identity; `shapeTokens` + `jaccard`/`minhash` give near-match on structure with values ignored (so "4 vs 5 nav children" diverges regardless of link text). Operates on plain JSON so it's Arbor-free and testable; a consumer feeds it `arbor.tree.toJson(id)` for the subtrees it wants to compare.

- [ ] **Step 1: Write the failing test** (`test/analyze-struct.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { structuralHash, shapeTokens, jaccard, minhashSignature, minhashSimilarity } from "../src/analyze-struct";

describe("structuralHash", () => {
  it("is stable under key reordering; differs on structural change", () => {
    expect(structuralHash({ a: 1, b: 2 })).toBe(structuralHash({ b: 2, a: 1 }));
    expect(structuralHash({ items: [1, 2, 3] })).not.toBe(structuralHash({ items: [1, 2] }));
  });
});
describe("shapeTokens + jaccard", () => {
  it("a 4-item vs 5-item list share <1 similarity regardless of values", () => {
    const four = { nav: [{ t: "A" }, { t: "B" }, { t: "C" }, { t: "D" }] };
    const fourDiffText = { nav: [{ t: "W" }, { t: "X" }, { t: "Y" }, { t: "Z" }] };
    const five = { nav: [{ t: "A" }, { t: "B" }, { t: "C" }, { t: "D" }, { t: "E" }] };
    expect(jaccard(shapeTokens(four), shapeTokens(fourDiffText))).toBe(1); // same shape, different text
    expect(jaccard(shapeTokens(four), shapeTokens(five))).toBeLessThan(1);  // count differs
  });
});
describe("minhash", () => {
  it("estimates jaccard within tolerance and is deterministic", () => {
    const a = shapeTokens({ nav: [{ t: 1 }, { t: 2 }, { t: 3 }, { t: 4 }] });
    const b = shapeTokens({ nav: [{ t: 1 }, { t: 2 }, { t: 3 }] });
    const sa = minhashSignature(a, { numHashes: 128, seed: 1 });
    const sb = minhashSignature(b, { numHashes: 128, seed: 1 });
    expect(minhashSignature(a, { numHashes: 128, seed: 1 })).toEqual(sa); // deterministic
    expect(Math.abs(minhashSimilarity(sa, sb) - jaccard(a, b))).toBeLessThan(0.2);
  });
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Create `src/analyze-struct.ts`**

```ts
import type { Json } from "./types";

/** Canonical JSON string: object keys sorted recursively so structurally-equal
 *  values with different key order serialize identically. Arrays keep order. */
export function canonicalize(value: Json): string {
  const walk = (v: Json): Json => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, Json> = {};
      for (const k of Object.keys(v as Record<string, Json>).sort()) out[k] = walk((v as Record<string, Json>)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

/** cyrb53 — fast, well-distributed, deterministic non-cryptographic hash (hex).
 *  Sufficient for equality grouping + MinHash at tree scale; no crypto dep. */
export function hashString(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/** Exact structural hash of a JSON value. Equal hash ⇒ identical after key
 *  normalization. (Returns a hash — NOT a boolean "consistent".) */
export function structuralHash(value: Json): string { return hashString(canonicalize(value)); }

/** Shape tokens: structure described as a set of strings, VALUES IGNORED. Each
 *  object contributes its sorted key-set at its path, each array its "[]:len",
 *  recursively; leaves contribute their type. Same shape, different text ⇒ same
 *  tokens; a 4- vs 5-child list ⇒ different tokens. */
export function shapeTokens(value: Json): Set<string> {
  const tokens = new Set<string>();
  const walk = (v: Json, prefix: string): void => {
    if (Array.isArray(v)) { tokens.add(`${prefix}[]:${v.length}`); v.forEach((e, i) => walk(e, `${prefix}[${i}]`)); }
    else if (v && typeof v === "object") {
      const keys = Object.keys(v as Record<string, Json>).sort();
      tokens.add(`${prefix}{${keys.join(",")}}`);
      for (const k of keys) walk((v as Record<string, Json>)[k], `${prefix}.${k}`);
    } else tokens.add(`${prefix}:${typeof v}`);
  };
  walk(value, "");
  return tokens;
}

/** Jaccard similarity of two sets: |A∩B| / |A∪B|, in [0,1] (empty∩empty → 1). */
export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** MinHash signature over a token set: `numHashes` mins under seeded deterministic
 *  permutations. Comparing signatures estimates Jaccard in O(numHashes). */
export function minhashSignature(tokens: Set<string>, opts: { numHashes?: number; seed?: number } = {}): number[] {
  const n = opts.numHashes ?? 64, seed = opts.seed ?? 1;
  const sig = new Array<number>(n).fill(0xffffffff);
  for (const t of tokens) {
    const base = parseInt(hashString(t).slice(-8), 16) >>> 0;
    for (let i = 0; i < n; i++) {
      const a = ((seed + i) * 2654435761) >>> 0;
      const b = ((seed ^ (i + 1)) * 40503) >>> 0;
      const h = (Math.imul(a, base) + b) >>> 0;
      if (h < sig[i]) sig[i] = h;
    }
  }
  return sig;
}

/** Estimated Jaccard from two MinHash signatures (fraction of equal positions). */
export function minhashSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let eq = 0;
  for (let i = 0; i < n; i++) if (a[i] === b[i]) eq++;
  return eq / n;
}
```

- [ ] **Step 4: Run tests** — PASS.
- [ ] **Step 5: Commit** — `feat(analyze): structural hashing + shape tokens + Jaccard/MinHash`

---

## Task 6 — `analyze-graph`: similarity & directed graphs + algorithms

**Files:** Create `src/analyze-graph.ts`, `test/analyze-graph.test.ts`.

`knnGraph` builds an undirected similarity graph (cosine weights). `Digraph = Map<string,string[]>` for caller-built directed graphs (e.g. a nav/link graph — domain edges, native algorithms). Algorithms: `connectedComponents`, `findCycles`, `topoSort`, `degrees`, `reachable`, `orphans`.

- [ ] **Step 1: Write the failing test** (`test/analyze-graph.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { knnGraph, connectedComponents, findCycles, topoSort, degrees, reachable, orphans } from "../src/analyze-graph";

describe("knnGraph + components", () => {
  it("links near neighbours, separates far blobs", () => {
    const view = [{ id: "a", vector: [0, 0] }, { id: "b", vector: [0.1, 0] }, { id: "c", vector: [9, 9] }, { id: "d", vector: [9.1, 9] }];
    const g = knnGraph(view, { k: 1, minWeight: 0.5 });
    const comps = connectedComponents(g.nodes, g.edges).map((c) => c.sort().join(","));
    expect(comps.sort()).toEqual(["a,b", "c,d"]);
  });
});
describe("directed algos", () => {
  it("cycles, topo, degrees, reachability, orphans", () => {
    expect(findCycles(new Map([["a", ["b"]], ["b", ["c"]], ["c", ["a"]]])).length).toBeGreaterThan(0);
    expect(topoSort(new Map([["a", ["b"]], ["b", ["c"]], ["c", []]]))).toEqual(["a", "b", "c"]);
    expect(topoSort(new Map([["a", ["b"]], ["b", ["a"]]]))).toBeNull();
    expect(degrees(new Map([["a", ["b", "c"]], ["b", []], ["c", []]]))["a"]).toEqual({ in: 0, out: 2 });
    const g = new Map([["home", ["a"]], ["a", []], ["orphan", []]]);
    expect(reachable(g, ["home"]).has("a")).toBe(true);
    expect(orphans(g, ["home"], ["home", "a", "orphan"])).toEqual(["orphan"]);
  });
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Create `src/analyze-graph.ts`**

```ts
import type { LabeledVector } from "./analyze";
import { cosine } from "./vec-math";

export interface SimEdge { a: string; b: string; weight: number; }
export interface SimGraph { nodes: string[]; edges: SimEdge[]; }
export type Digraph = Map<string, string[]>;

/** Undirected k-NN similarity graph (cosine weights). Edges below minWeight dropped.
 *  Deterministic (stable neighbour order by score then id). O(n^2) — fine at v1. */
export function knnGraph(view: LabeledVector[], opts: { k: number; minWeight?: number }): SimGraph {
  const minW = opts.minWeight ?? -Infinity;
  const nodes = view.map((v) => v.id);
  const seen = new Set<string>(); const edges: SimEdge[] = [];
  for (let i = 0; i < view.length; i++) {
    const sims = view.map((o, j) => ({ j, w: i === j ? -Infinity : cosine(view[i].vector, o.vector) }))
      .sort((x, y) => (y.w - x.w) || (view[x.j].id < view[y.j].id ? -1 : 1)).slice(0, opts.k);
    for (const { j, w } of sims) {
      if (w < minW) continue;
      const [a, b] = view[i].id < view[j].id ? [view[i].id, view[j].id] : [view[j].id, view[i].id];
      const key = `${a} ${b}`;
      if (seen.has(key)) continue;
      seen.add(key); edges.push({ a, b, weight: w });
    }
  }
  return { nodes, edges };
}

/** Connected components of an undirected graph (union-find). */
export function connectedComponents(nodes: string[], edges: SimEdge[]): string[][] {
  const parent = new Map<string, string>(nodes.map((n) => [n, n]));
  const find = (x: string): string => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; } return x; };
  for (const e of edges) { const ra = find(e.a), rb = find(e.b); if (ra !== rb) parent.set(ra, rb); }
  const groups = new Map<string, string[]>();
  for (const n of nodes) { const r = find(n); const g = groups.get(r); if (g) g.push(n); else groups.set(r, [n]); }
  return [...groups.values()];
}

/** Member sets of directed cycles (DFS colouring). One list per back-edge cycle —
 *  a presence signal; the caller decides significance. */
export function findCycles(g: Digraph): string[][] {
  const WHITE = 0, GREY = 1, BLACK = 2;
  const colour = new Map<string, number>(); const stack: string[] = []; const cycles: string[][] = [];
  const nodes = new Set<string>([...g.keys(), ...[...g.values()].flat()]);
  for (const n of nodes) colour.set(n, WHITE);
  const dfs = (u: string) => {
    colour.set(u, GREY); stack.push(u);
    for (const v of g.get(u) ?? []) {
      if (colour.get(v) === GREY) cycles.push(stack.slice(stack.indexOf(v)));
      else if (colour.get(v) === WHITE) dfs(v);
    }
    colour.set(u, BLACK); stack.pop();
  };
  for (const n of nodes) if (colour.get(n) === WHITE) dfs(n);
  return cycles;
}

/** Kahn topological order, or null if the graph has a cycle. */
export function topoSort(g: Digraph): string[] | null {
  const nodes = new Set<string>([...g.keys(), ...[...g.values()].flat()]);
  const indeg = new Map<string, number>([...nodes].map((n) => [n, 0]));
  for (const [, outs] of g) for (const v of outs) indeg.set(v, (indeg.get(v) ?? 0) + 1);
  const queue = [...nodes].filter((n) => (indeg.get(n) ?? 0) === 0).sort();
  const order: string[] = [];
  while (queue.length) {
    const u = queue.shift()!; order.push(u);
    for (const v of g.get(u) ?? []) { const d = (indeg.get(v) ?? 0) - 1; indeg.set(v, d); if (d === 0) queue.push(v); }
    queue.sort();
  }
  return order.length === nodes.size ? order : null;
}

/** In/out degree per node. */
export function degrees(g: Digraph): Record<string, { in: number; out: number }> {
  const nodes = new Set<string>([...g.keys(), ...[...g.values()].flat()]);
  const out: Record<string, { in: number; out: number }> = {};
  for (const n of nodes) out[n] = { in: 0, out: 0 };
  for (const [u, outs] of g) { out[u].out += outs.length; for (const v of outs) out[v].in += 1; }
  return out;
}

/** Nodes reachable from any root via directed edges (BFS). */
export function reachable(g: Digraph, roots: string[]): Set<string> {
  const seen = new Set<string>(roots); const queue = [...roots];
  while (queue.length) { const u = queue.shift()!; for (const v of g.get(u) ?? []) if (!seen.has(v)) { seen.add(v); queue.push(v); } }
  return seen;
}

/** Nodes in `all` not reachable from any root (e.g. orphan pages). */
export function orphans(g: Digraph, roots: string[], all: string[]): string[] {
  const r = reachable(g, roots);
  return all.filter((n) => !r.has(n));
}
```

- [ ] **Step 4: Run tests** — PASS.
- [ ] **Step 5: Commit** — `feat(analyze): similarity + directed graph algorithms (components, cycles, topo, reachability, orphans)`

---

## Task 7 — `analyze-tools`: LLM tool bridge

**Files:** Create `src/analyze-tools.ts`, `test/analyze-tools.test.ts`.

Mirrors `agent-tools.ts`: `analyzeToolDefs()` (plain-JSON defs) + `makeAnalyzeExecutor(arbor)` (never-throw `(tool,input)→JSON`). Same error vocabulary + cap. Tools: `cluster`, `outliers` (global), `local_outliers`, `silhouette`, `similarity_graph`, `components`, `structural_groups` (group nodes under a path / of a type by exact `structuralHash` → which subtrees are identical vs divergent — directly answers "are these N headers the same"). Returns metrics/structures; the executor renders NO verdict.

- [ ] **Step 1: Write the failing test** (`test/analyze-tools.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { createArbor } from "../src/arbor";
import { MockEmbeddingPort } from "../src/embedding-port";
import { sizeBasedDecision } from "../src/decompose";
import { analyzeToolDefs, makeAnalyzeExecutor } from "../src/analyze-tools";

describe("analyze-tools", () => {
  it("exposes the tool defs as plain JSON schema", () => {
    const names = analyzeToolDefs().map((d) => d.name).sort();
    expect(names).toEqual(["cluster", "components", "local_outliers", "outliers", "silhouette", "similarity_graph", "structural_groups"]);
  });
  it("runs cluster → JSON with assignments", async () => {
    const arbor = createArbor({ initial: { a: "alpha", b: "beta", c: "gamma" }, embedding: new MockEmbeddingPort(), decompose: sizeBasedDecision(1) });
    await arbor.index!.reindex();
    const out = JSON.parse(await makeAnalyzeExecutor(arbor)("cluster", { k: 2, seed: 1 }));
    expect(out.ok).toBe(true); expect(out.value).toHaveProperty("assignments");
  });
  it("structural_groups groups identical subtrees under a path", async () => {
    const arbor = createArbor({ initial: { pages: { p1: { nav: ["H", "R"] }, p2: { nav: ["H", "R"] }, p3: { nav: ["H", "R", "X"] } } }, embedding: new MockEmbeddingPort(), decompose: sizeBasedDecision(1) });
    await arbor.index!.reindex();
    const out = JSON.parse(await makeAnalyzeExecutor(arbor)("structural_groups", { under: "/pages" }));
    expect(out.ok).toBe(true);
    // p1 & p2 share a hash; p3 differs → at least 2 distinct groups
    expect(out.value.groups.length).toBeGreaterThanOrEqual(2);
  });
  it("unknown tool → never-throw error JSON", async () => {
    const out = JSON.parse(await makeAnalyzeExecutor(createArbor({ embedding: new MockEmbeddingPort() }))("nope", {}));
    expect(out.ok).toBe(false); expect(out.error.code).toBe("UNKNOWN_TOOL");
  });
});
```
(Implementer: `structural_groups` reads nodes via `find`/tree traversal under `under` (or by `type`) and `arbor.tree.toJson(id)` per node; group node paths by `structuralHash`. For the grouping granularity — group the DIRECT children of `under` (each child = one comparable subtree). Confirm the navigator/`find` API for enumerating children of a path.)

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Create `src/analyze-tools.ts`** — reuse `agent-tools.ts` patterns (import `AgentToolDef` type from `./agent-tools`; frozen leaf schema constants; never-throw executor with `DEFAULT_MAX_RESULT_CHARS` cap; error codes `UNKNOWN_TOOL`/`INVALID_INPUT`/`TOO_LARGE`/`EXECUTOR_ERROR`). Dispatch:
  - `cluster` → `collectVectors` + `kmeans` (k, seed default 1);
  - `outliers` → `outlierScores`, sort desc, slice `topN` (default 10);
  - `local_outliers` → `localOutlierScores` (k), sort desc, slice `topN`;
  - `silhouette` → `kmeans` (k, seed) then `silhouette` → `{mean, perItem}`;
  - `similarity_graph` → `knnGraph` (k, minWeight);
  - `components` → `connectedComponents(knnGraph(...))`;
  - `structural_groups` → enumerate direct children under `under` (or nodes of `type`), `structuralHash(tree.toJson(child))`, return `{groups: [{hash, paths}]}`.
  - Determinism: default `seed` to 1.

- [ ] **Step 4: Run tests** — PASS.
- [ ] **Step 5: Commit** — `feat(analyze): LLM tool bridge (analyzeToolDefs + makeAnalyzeExecutor)`

---

## Task 8 — packaging, barrel, version, changelog

**Files:** Modify `src/index.ts`, `package.json`, `CHANGELOG.md`, the m11 packaging test.

- [ ] **Step 1: Barrel** — add to `src/index.ts` (after the `agent-tools` line):
```ts
export * from "./vec-math";
export * from "./analyze";
export * from "./analyze-struct";
export * from "./analyze-graph";
export * from "./analyze-tools";
```
  Confirm no exported symbol name collides across these (esp. `LabeledVector` lives ONLY in `analyze`; `analyze-graph`/`analyze-tools` import it as a type). typecheck/build catches a real collision.

- [ ] **Step 2: `package.json` exports** — add five entries (alphabetical), mirroring the existing pattern:
```json
"./analyze": { "types": "./dist/analyze.d.ts", "import": "./dist/analyze.js" },
"./analyze-graph": { "types": "./dist/analyze-graph.d.ts", "import": "./dist/analyze-graph.js" },
"./analyze-struct": { "types": "./dist/analyze-struct.d.ts", "import": "./dist/analyze-struct.js" },
"./analyze-tools": { "types": "./dist/analyze-tools.d.ts", "import": "./dist/analyze-tools.js" },
"./vec-math": { "types": "./dist/vec-math.d.ts", "import": "./dist/vec-math.js" },
```
  tsup `entry: ["src/*.ts"]` picks the files up automatically — no tsup change.

- [ ] **Step 3: Version bump** — `package.json` `"1.3.0"` → `"1.4.0"`.

- [ ] **Step 4: Packaging regression test** — find the m11 test that pins the exports map (search `test/` for `exports`/`subpath`). Add the five new subpaths so its negative test (chunks private, every declared subpath imports cleanly) still passes.

- [ ] **Step 5: CHANGELOG** — add `## 1.4.0`: native analysis layer — vector analytics (kmeans/silhouette/global+kNN-local outliers/nearest-centroid classify), structural analytics (subtree hash/shape tokens/Jaccard/MinHash), graph algorithms (sim graph, components, cycles, topo, reachability/orphans), and an LLM tool bridge; verdict-free by design (thresholds/labels stay in the consumer); zero new deps.

- [ ] **Step 6: Commit** — `chore(analyze): package exports, barrel, 1.4.0, changelog`

---

## Task 9 — green build

- [ ] `npm test` — full suite green (409 + new tests).
- [ ] `npm run typecheck` — clean.
- [ ] `npm run build` — clean; confirm `dist/{vec-math,analyze,analyze-struct,analyze-graph,analyze-tools}.{js,d.ts}` emitted.
- [ ] Smoke: `import { kmeans } from "arborkit/analyze"`, `import { structuralHash } from "arborkit/analyze-struct"`, `import { knnGraph } from "arborkit/analyze-graph"` resolve against `dist`.

---

## Verification

**Automated:** `npx vitest run` + `npm run typecheck` + `npm run build` in `c:\code\tools\arbor`.

**Manual API smoke (optional):** build an arbor with `MockEmbeddingPort`, insert text nodes + a couple of sibling subtrees, `reindex()`, then exercise `collectVectors`→`kmeans`/`silhouette`/`localOutlierScores`, `structuralHash`/`shapeTokens`/`jaccard`, `knnGraph`/`orphans`, and the seven `makeAnalyzeExecutor` tools (never-throw JSON).

**Downstream (separate, NOT in this plan):** the generator consumes this layer to build DOMAIN evaluators — topic-drift (local outliers + silhouette vs the run's page set), menu/chrome consistency (`structural_groups` over the header/footer section nodes), orphan pages (`orphans` on the nav link graph). Those supply the thresholds/labels/verdicts this layer omits.

## Risks

- **`vectors.entries()` cost / support.** `MemoryVectorIndex` implements it; a DB-backed port might make it expensive/partial. v1 targets in-memory scale; `collectVectors` materializes all vectors — flagged, no mitigation now.
- **O(n²) knn/graph & silhouette.** Fine at hundreds of nodes. Do NOT prematurely optimize; ANN is a later concern.
- **Determinism.** LCG (k-means) and seeded MinHash permutations must be the ONLY randomness — reviewer confirms no `Math.random`/`Date.now`.
- **Verdict leak (top review focus).** No function returns pass/fail or a baked threshold. `outlierScores`/`localOutlierScores` return distances; `structuralHash` returns a hash; `silhouette` returns a score. A `structural_groups` tool returns groups, NOT "inconsistent".
- **`hashString` is non-cryptographic** (cyrb53) — used for equality grouping + MinHash only, never for security. Collisions are astronomically unlikely at tree scale but semantically possible; acceptable for this use.
- **Barrel name collisions.** `export *` over five modules — confirm unique symbol names; `OutlierScore`/`LabeledVector` defined once in `analyze`.
- **vector-index-port refactor (Task 1 opt).** If done, edits a stable packaged hot-path module; its tests must stay green. If any doubt, skip (allowed).

## Out of scope (follow-up)
- Domain evaluators (menu/topic/brand-facts/orphans) — belong in the generator, consume this layer.
- Persisting an `/analysis` result node + cross-version regression tracking — a consumer concern; `compareScores` is the only diff primitive shipped.
- Full LOF (reachability-density), HDBSCAN/DBSCAN, spectral clustering, PCA/UMAP, betweenness/PageRank centrality, tree-edit-distance — not clearly needed for the target eval use; each is a later verdict-free addition of the same shape if a concrete need appears.
