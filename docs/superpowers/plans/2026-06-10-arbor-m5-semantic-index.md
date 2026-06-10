# Arbor — M5: Semantic Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the per-node semantic index — the unoccupied-niche differentiator — so an agent can `search` the artifact by meaning: embeddings per content-bearing node (via swappable `EmbeddingPort`), a brute-force `VectorIndexPort`, a co-located stale lifecycle driven by mutations, an async batched reindexer, and `search` with freshness modes.

**Architecture:** A new `SemanticIndex` owns the `EmbeddingPort`, `VectorIndexPort`, a stale-node queue, the per-node embedding-text extraction (`toEmbeddingText`, type-aware via `TypeDef.embedText`), the async `reindex`, and `search`. It plugs into the `Mutator` through two new optional hooks on `MutatorDeps` — `onChange` (set/insert) and `onRemove` (remove) — so a content change marks the node's `meta.embedding` stale and a removal drops it. `move` does NOT fire `onChange` (content is unchanged — a key payoff of id-identity). Embedding is async and never in the mutation path; mutations only mark stale (with a `textHash` dedupe so edits to non-embedded fields cost nothing). `search` embeds the query, ranks by cosine, post-filters by `under`/`type`/`tag`, and reports `staleCount`; `freshness: "wait"` flushes the reindexer first.

**Tech Stack:** Node ≥20.6, TypeScript (ESM, strict), Vitest. No new runtime dependencies (the `EmbeddingPort` is an interface; M5 ships a deterministic mock + an in-memory brute-force vector index). Builds on M1–M4.

---

## Scope of THIS plan (Milestone 5)

Covers spec §7 (semantic channel: per-node embeddings, `toEmbeddingText`, stale lifecycle + `textHash` dedupe, async reindexer, `VectorIndexPort` brute-force, `search` with `best-effort`/`wait` + `staleCount`, `reindex`) and §10.5. Produces working, testable software: mutate the tree → affected nodes go stale → reindex → `search` by meaning with exact post-filters.

**Out of scope here (later milestones):** real embedding providers (M5 ships only a deterministic `MockEmbeddingPort`; production adapters are pluggable later), pgvector/sqlite-vec `VectorIndexPort` (M6 storage), persistence of vectors (M6), replay (M7), the scoped `makeToolset` + LangChain wrappers that expose `search` alongside `describe`/`get`/`find`/`patch` (M8). Also deferred: HNSW/ANN indexing (brute-force is correct at current scale), and embedding-provider batching limits/retries.

## Design decisions (locked for M5)

1. **`SemanticIndex` is a separate component** wired into the `Mutator` via two optional `MutatorDeps` hooks (`onChange`, `onRemove`). The Mutator stays unaware of embeddings; it just notifies. This mirrors the existing `validate` hook seam.
2. **Mutations mark stale synchronously; embedding is async.** `onChange` computes `toEmbeddingText`, hashes it, and — only if the hash differs from the node's stored `textHash` (or there's no current embedding) — sets `meta.embedding.state = "stale"` and enqueues. A patch to a non-embedded field (same embedding-text) is a no-op. `move` fires no hook (content unchanged → embedding stays valid).
3. **`toEmbeddingText` default:** type's `embedText` wins; else a `leaf` with a string value → the string, a `leaf` with an opaque object/array → its JSON, other leaves (number/bool/null) and all containers → `null` (not embedded).
4. **Reindexer is async + batched:** pulls the stale set, computes texts, calls `EmbeddingPort.embed(texts)` once, upserts vectors, sets nodes `fresh` with the recomputed `textHash`, and clears the processed ids from the stale set.
5. **`search`** embeds the query, ranks ALL indexed vectors by cosine (brute-force), post-filters by `under` (JSON-Pointer prefix) / `type` / `tag`, returns top-`k` `{id, path, type, score, snippet}` plus `staleCount`. `freshness` default `best-effort` (search what's indexed, report `staleCount`); `freshness: "wait"` awaits `reindex()` first.
6. **No persistence:** the vector index is in-memory and rebuildable from the tree (derived data). Snapshot/restore of vectors is M6.

## File Structure (Milestone 5)

- Create: `src/embedding-port.ts` — `EmbeddingPort` interface + `MockEmbeddingPort` (deterministic).
- Create: `src/vector-index-port.ts` — `VectorIndexPort` interface, `VectorIndexEntry`/`VectorHit`, `MemoryVectorIndex` (brute-force cosine).
- Create: `src/embedding-text.ts` — `toEmbeddingText(node, value, typeDef?)`, `textHash(text)`.
- Modify: `src/type-registry.ts` — add `embedText?` to `TypeDef`.
- Modify: `src/mutator.ts` — add `onChange?`/`onRemove?` to `MutatorDeps`; call them in `set`/`insert`/`remove` (NOT `move`).
- Create: `src/semantic-index.ts` — `SemanticIndex` (`onChange`/`onRemove`/`hooks`/`staleCount`/`reindex`/`search`) + result/opts types.
- Test: `test/embedding-port.test.ts`, `test/vector-index-port.test.ts`, `test/embedding-text.test.ts`, `test/semantic-index.test.ts`, `test/mutator-hooks.test.ts`, `test/semantic-search.test.ts`, `test/m5-semantic.test.ts`.

---

### Task 1: `EmbeddingPort` + `MockEmbeddingPort`

**Files:**
- Create: `src/embedding-port.ts`
- Test: `test/embedding-port.test.ts`

- [ ] **Step 1: Write the failing test `test/embedding-port.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { MockEmbeddingPort } from "../src/embedding-port";

describe("MockEmbeddingPort", () => {
  it("returns one vector per input text, each of the configured dimension", async () => {
    const port = new MockEmbeddingPort(8);
    const vecs = await port.embed(["hello", "world"]);
    expect(vecs.length).toBe(2);
    expect(vecs[0].length).toBe(8);
    expect(port.dims).toBe(8);
  });

  it("is deterministic: identical text yields an identical vector", async () => {
    const port = new MockEmbeddingPort();
    const [a] = await port.embed(["same"]);
    const [b] = await port.embed(["same"]);
    expect(a).toEqual(b);
  });

  it("different text yields a different vector", async () => {
    const port = new MockEmbeddingPort();
    const [a] = await port.embed(["alpha"]);
    const [b] = await port.embed(["beta"]);
    expect(a).not.toEqual(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/embedding-port.test.ts`
Expected: FAIL — cannot resolve `../src/embedding-port`.

- [ ] **Step 3: Write `src/embedding-port.ts`**

```ts
/** Turns text into vectors. Swappable; production adapters (OpenAI, local, etc.) implement this. */
export interface EmbeddingPort {
  readonly dims: number;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Deterministic test/dev embedding: sums char codes into fixed-dimension buckets.
 * Same text → same vector (so an exact-text query ranks its node first); no network.
 */
export class MockEmbeddingPort implements EmbeddingPort {
  constructor(readonly dims = 32) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vectorize(t));
  }

  private vectorize(text: string): number[] {
    const v = new Array<number>(this.dims).fill(0);
    for (let i = 0; i < text.length; i++) {
      v[i % this.dims] += text.charCodeAt(i);
    }
    return v;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/embedding-port.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/embedding-port.ts test/embedding-port.test.ts
git commit -m "feat: EmbeddingPort + deterministic MockEmbeddingPort"
```

---

### Task 2: `VectorIndexPort` + `MemoryVectorIndex`

**Files:**
- Create: `src/vector-index-port.ts`
- Test: `test/vector-index-port.test.ts`

- [ ] **Step 1: Write the failing test `test/vector-index-port.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { MemoryVectorIndex } from "../src/vector-index-port";

describe("MemoryVectorIndex", () => {
  it("upserts vectors and ranks by cosine similarity (closest first)", () => {
    const idx = new MemoryVectorIndex();
    idx.upsert([
      { nodeId: "a", vector: [1, 0] },
      { nodeId: "b", vector: [0, 1] },
      { nodeId: "c", vector: [1, 1] },
    ]);
    const hits = idx.search([1, 0], 3);
    expect(hits[0].nodeId).toBe("a"); // identical direction → cosine 1
    expect(hits[0].score).toBeCloseTo(1, 5);
    expect(hits.map((h) => h.nodeId)).toContain("c");
    expect(hits[hits.length - 1].nodeId).toBe("b"); // orthogonal → lowest
  });

  it("respects k", () => {
    const idx = new MemoryVectorIndex();
    idx.upsert([
      { nodeId: "a", vector: [1, 0] },
      { nodeId: "b", vector: [0, 1] },
    ]);
    expect(idx.search([1, 0], 1).length).toBe(1);
  });

  it("upsert replaces an existing vector for the same nodeId", () => {
    const idx = new MemoryVectorIndex();
    idx.upsert([{ nodeId: "a", vector: [1, 0] }]);
    idx.upsert([{ nodeId: "a", vector: [0, 1] }]);
    expect(idx.size()).toBe(1);
  });

  it("remove drops a vector; has/size reflect membership", () => {
    const idx = new MemoryVectorIndex();
    idx.upsert([{ nodeId: "a", vector: [1, 0] }]);
    expect(idx.has("a")).toBe(true);
    idx.remove("a");
    expect(idx.has("a")).toBe(false);
    expect(idx.size()).toBe(0);
  });

  it("returns score 0 for a zero-magnitude vector (no NaN)", () => {
    const idx = new MemoryVectorIndex();
    idx.upsert([{ nodeId: "a", vector: [0, 0] }]);
    const hits = idx.search([1, 0], 1);
    expect(hits[0].score).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/vector-index-port.test.ts`
Expected: FAIL — cannot resolve `../src/vector-index-port`.

- [ ] **Step 3: Write `src/vector-index-port.ts`**

```ts
import type { NodeId } from "./types";

export interface VectorIndexEntry {
  nodeId: NodeId;
  vector: number[];
}

export interface VectorHit {
  nodeId: NodeId;
  score: number;
}

/** Stores per-node vectors and ranks by similarity. Brute-force impl below; pgvector/sqlite-vec later. */
export interface VectorIndexPort {
  upsert(entries: VectorIndexEntry[]): void;
  remove(nodeId: NodeId): void;
  search(query: number[], k: number): VectorHit[];
  has(nodeId: NodeId): boolean;
  size(): number;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** In-memory brute-force cosine index. Correct and simple at current scale. */
export class MemoryVectorIndex implements VectorIndexPort {
  private readonly vectors = new Map<NodeId, number[]>();

  upsert(entries: VectorIndexEntry[]): void {
    for (const e of entries) this.vectors.set(e.nodeId, e.vector);
  }

  remove(nodeId: NodeId): void {
    this.vectors.delete(nodeId);
  }

  has(nodeId: NodeId): boolean {
    return this.vectors.has(nodeId);
  }

  size(): number {
    return this.vectors.size;
  }

  search(query: number[], k: number): VectorHit[] {
    const hits: VectorHit[] = [];
    for (const [nodeId, vector] of this.vectors) {
      hits.push({ nodeId, score: cosine(query, vector) });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/vector-index-port.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/vector-index-port.ts test/vector-index-port.test.ts
git commit -m "feat: VectorIndexPort + MemoryVectorIndex (brute-force cosine)"
```

---

### Task 3: `toEmbeddingText` + `textHash` + `TypeDef.embedText`

**Files:**
- Create: `src/embedding-text.ts`
- Modify: `src/type-registry.ts` (add `embedText?` to `TypeDef`; no other change)
- Test: `test/embedding-text.test.ts`

- [ ] **Step 1: Write the failing test `test/embedding-text.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { toEmbeddingText, textHash } from "../src/embedding-text";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function leafFor(json: unknown, path: string) {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson(json as never, deps);
  const addressing = new Addressing(tree);
  return { tree, node: addressing.byPath(path)! };
}

describe("toEmbeddingText", () => {
  it("returns a string leaf's value verbatim", () => {
    const { node } = leafFor({ t: "Hello" }, "/t");
    expect(toEmbeddingText(node, "Hello")).toBe("Hello");
  });

  it("returns null for a numeric/boolean leaf (not worth embedding by default)", () => {
    const { node } = leafFor({ n: 42 }, "/n");
    expect(toEmbeddingText(node, 42)).toBeNull();
  });

  it("returns null for a structural container by default", () => {
    const { tree } = leafFor({ a: { b: 1 } }, "/a");
    const root = tree.root();
    expect(toEmbeddingText(root, tree.toJson(root.id))).toBeNull();
  });

  it("uses a type's embedText override when present", () => {
    const { node } = leafFor({ t: "x" }, "/t");
    const typeDef = { embedText: (v: unknown) => `custom:${JSON.stringify(v)}` };
    expect(toEmbeddingText(node, "x", typeDef)).toBe('custom:"x"');
  });
});

describe("textHash", () => {
  it("is deterministic and differs for different text", () => {
    expect(textHash("abc")).toBe(textHash("abc"));
    expect(textHash("abc")).not.toBe(textHash("abd"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/embedding-text.test.ts`
Expected: FAIL — cannot resolve `../src/embedding-text`.

- [ ] **Step 3: Add `embedText?` to `TypeDef` in `src/type-registry.ts`**

Replace the existing `TypeDef` interface with:

```ts
/** Definition of a registered node type. */
export interface TypeDef {
  /** Validate a value about to be stored at a node of this type. Throw to reject. */
  validate?: (value: Json) => void;
  /** Override the size-based decomposition for nodes of this type. */
  decompose?: "opaque" | "children";
  /** Override the text used to embed nodes of this type. Return null to skip embedding. */
  embedText?: (value: Json) => string | null;
}
```

- [ ] **Step 4: Write `src/embedding-text.ts`**

```ts
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/embedding-text.test.ts`
Expected: PASS (5 tests). Then `npx vitest run` — no regressions (the `TypeDef.embedText` addition is optional; M3 tests unaffected).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/embedding-text.ts src/type-registry.ts test/embedding-text.test.ts
git commit -m "feat: toEmbeddingText + textHash + TypeDef.embedText override"
```

---

### Task 4: `SemanticIndex` — lifecycle (`onChange`/`onRemove`/`reindex`)

**Files:**
- Create: `src/semantic-index.ts`
- Test: `test/semantic-index.test.ts`

- [ ] **Step 1: Write the failing test `test/semantic-index.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { SemanticIndex } from "../src/semantic-index";
import { MockEmbeddingPort } from "../src/embedding-port";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function setup(json: unknown) {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson(json as never, deps);
  const addressing = new Addressing(tree);
  const vectors = new MemoryVectorIndex();
  const index = new SemanticIndex(tree, addressing, new MockEmbeddingPort(), vectors);
  return { tree, addressing, vectors, index };
}

describe("SemanticIndex lifecycle", () => {
  it("onChange marks an embeddable leaf stale and enqueues it", () => {
    const { addressing, index } = setup({ t: "hello world" });
    const node = addressing.byPath("/t")!;
    index.onChange(node);
    expect(node.meta.embedding.state).toBe("stale");
    expect(index.staleCount()).toBe(1);
  });

  it("onChange marks a non-embeddable node 'none' and does not enqueue", () => {
    const { addressing, index } = setup({ n: 42 });
    const node = addressing.byPath("/n")!;
    index.onChange(node);
    expect(node.meta.embedding.state).toBe("none");
    expect(index.staleCount()).toBe(0);
  });

  it("reindex embeds stale nodes, upserts vectors, marks them fresh, and clears the queue", async () => {
    const { addressing, vectors, index } = setup({ t: "hello world" });
    const node = addressing.byPath("/t")!;
    index.onChange(node);
    await index.reindex();
    expect(node.meta.embedding.state).toBe("fresh");
    expect(vectors.has(node.id)).toBe(true);
    expect(index.staleCount()).toBe(0);
  });

  it("textHash dedupe: onChange on a node whose embedding-text is unchanged is a no-op", async () => {
    const { addressing, index } = setup({ t: "hello" });
    const node = addressing.byPath("/t")!;
    index.onChange(node);
    await index.reindex(); // now fresh with a stored textHash
    index.onChange(node); // same content/text → no re-stale
    expect(node.meta.embedding.state).toBe("fresh");
    expect(index.staleCount()).toBe(0);
  });

  it("onRemove drops the node from the vector index and the stale queue", async () => {
    const { addressing, vectors, index } = setup({ t: "hello" });
    const node = addressing.byPath("/t")!;
    const id = node.id;
    index.onChange(node);
    await index.reindex();
    index.onRemove(id);
    expect(vectors.has(id)).toBe(false);
    expect(index.staleCount()).toBe(0);
  });

  it("hooks() returns onChange/onRemove bound to the index", () => {
    const { addressing, index } = setup({ t: "hi" });
    const h = index.hooks();
    h.onChange(addressing.byPath("/t")!);
    expect(index.staleCount()).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/semantic-index.test.ts`
Expected: FAIL — cannot resolve `../src/semantic-index`.

- [ ] **Step 3: Write `src/semantic-index.ts`**

```ts
import type { ArbNode, NodeId } from "./types";
import type { ArtifactTree } from "./artifact-tree";
import type { Addressing } from "./addressing";
import type { TypeRegistry } from "./type-registry";
import type { EmbeddingPort } from "./embedding-port";
import type { VectorIndexPort } from "./vector-index-port";
import { toEmbeddingText, textHash } from "./embedding-text";

/**
 * Owns the per-node semantic index: a stale queue fed by mutation hooks, an async
 * batched reindexer, and (Task 6) search. Embedding is never in the mutation path —
 * mutations only mark stale; reindex does the async embedding work.
 */
export class SemanticIndex {
  private readonly stale = new Set<NodeId>();

  constructor(
    private readonly tree: ArtifactTree,
    private readonly addressing: Addressing,
    private readonly embedding: EmbeddingPort,
    private readonly vectors: VectorIndexPort,
    private readonly registry?: TypeRegistry,
  ) {}

  /** Mutation hook: a node's content changed (set/insert). Marks it stale if its embedding-text changed. */
  onChange(node: ArbNode): void {
    const value = this.tree.toJson(node.id);
    const typeDef = node.type ? this.registry?.get(node.type) : undefined;
    const text = toEmbeddingText(node, value, typeDef);
    if (text === null) {
      node.meta.embedding = { state: "none" };
      this.vectors.remove(node.id);
      this.stale.delete(node.id);
      return;
    }
    const hash = textHash(text);
    if (node.meta.embedding.state === "fresh" && node.meta.embedding.textHash === hash) {
      return; // embedding-text unchanged — nothing to do
    }
    node.meta.embedding = { state: "stale", textHash: hash };
    this.stale.add(node.id);
  }

  /** Mutation hook: a node was removed. Drops it from the index and the stale queue. */
  onRemove(nodeId: NodeId): void {
    this.vectors.remove(nodeId);
    this.stale.delete(nodeId);
  }

  /** Convenience: the hooks to wire into `MutatorDeps`. */
  hooks(): { onChange: (node: ArbNode) => void; onRemove: (nodeId: NodeId) => void } {
    return {
      onChange: (node) => this.onChange(node),
      onRemove: (nodeId) => this.onRemove(nodeId),
    };
  }

  staleCount(): number {
    return this.stale.size;
  }

  /** Embed every stale node (one batch), upsert vectors, mark fresh, clear the processed ids. */
  async reindex(): Promise<void> {
    const ids = [...this.stale];
    if (ids.length === 0) return;
    const items: { id: NodeId; text: string; hash: string }[] = [];
    for (const id of ids) {
      const node = this.tree.get(id);
      if (!node) continue; // removed since enqueue
      const value = this.tree.toJson(id);
      const typeDef = node.type ? this.registry?.get(node.type) : undefined;
      const text = toEmbeddingText(node, value, typeDef);
      if (text === null) {
        node.meta.embedding = { state: "none" };
        this.vectors.remove(id);
        continue;
      }
      items.push({ id, text, hash: textHash(text) });
    }
    if (items.length > 0) {
      const embedded = await this.embedding.embed(items.map((it) => it.text));
      this.vectors.upsert(items.map((it, i) => ({ nodeId: it.id, vector: embedded[i] })));
      for (const it of items) {
        const node = this.tree.get(it.id)!;
        node.meta.embedding = { state: "fresh", textHash: it.hash };
      }
    }
    for (const id of ids) this.stale.delete(id);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/semantic-index.test.ts`
Expected: PASS (6 tests). Then `npx vitest run` — no regressions.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/semantic-index.ts test/semantic-index.test.ts
git commit -m "feat: SemanticIndex stale lifecycle + async batched reindexer"
```

---

### Task 5: `Mutator` change/remove hooks

**Files:**
- Modify: `src/mutator.ts` (add `onChange?`/`onRemove?` to `MutatorDeps`; replace `set`/`insert`/`remove`; do NOT change `move`/`transaction`/guards)
- Test: `test/mutator-hooks.test.ts`

- [ ] **Step 1: Write the failing test `test/mutator-hooks.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function setup(json: unknown) {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson(json as never, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const changed: string[] = [];
  const removed: string[] = [];
  const mutator = new Mutator(tree, addressing, log, {
    clock,
    onChange: (node) => changed.push(node.id),
    onRemove: (id) => removed.push(id),
  });
  return { tree, addressing, mutator, changed, removed };
}

describe("Mutator semantic hooks", () => {
  it("set fires onChange with the mutated node", () => {
    const { addressing, mutator, changed } = setup({ a: "x" });
    const id = addressing.byPath("/a")!.id;
    mutator.set({ path: "/a" }, "y");
    expect(changed).toEqual([id]);
  });

  it("insert fires onChange with the new node", () => {
    const { mutator, tree, changed } = setup({ items: {} });
    const id = mutator.insert({ path: "/items" }, "k", "v");
    expect(changed).toEqual([id]);
    expect(tree.get(id)).toBeDefined();
  });

  it("remove fires onRemove with the removed node id", () => {
    const { addressing, mutator, removed } = setup({ a: "x", b: "y" });
    const id = addressing.byPath("/b")!.id;
    mutator.remove({ path: "/b" });
    expect(removed).toEqual([id]);
  });

  it("move fires NEITHER onChange nor onRemove (content unchanged)", () => {
    const { addressing, mutator, changed, removed } = setup({ from: { x: "v" }, to: {} });
    changed.length = 0;
    removed.length = 0;
    const id = addressing.byPath("/from/x")!.id;
    mutator.move({ id }, { path: "/to" }, "x");
    expect(changed).toEqual([]);
    expect(removed).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mutator-hooks.test.ts`
Expected: FAIL — `MutatorDeps` has no `onChange`/`onRemove`; hooks never fire.

- [ ] **Step 3: Modify `src/mutator.ts`**

Replace the existing `MutatorDeps` interface with:

```ts
export interface MutatorDeps {
  clock: Clock;
  validate?: Validator;
  /** Called after a node's content changes (set/insert) — e.g. to mark a semantic index stale. */
  onChange?: (node: ArbNode) => void;
  /** Called after a node is removed — e.g. to drop it from a semantic index. */
  onRemove?: (nodeId: NodeId) => void;
}
```

Replace the existing `set` method with (adds `onChange` after `bump`):

```ts
  set(ref: Ref, value: Json, opts: MutateOpts = {}): void {
    const node = this.resolve(ref);
    this.checkScope(node, opts.writeScope);
    this.checkVersion(node, opts.ifVersion);
    const type = opts.type ?? node.type;
    this.deps.validate?.({ node, proposed: value, type, op: "set" });
    const before = this.tree.toJson(node.id);
    this.tree.replaceValue(node.id, value, type);
    if (opts.tags !== undefined) node.tags = opts.tags;
    this.bump(node, opts.owner);
    this.deps.onChange?.(node);
    this.log.append({
      kind: "set",
      targetId: node.id,
      parentId: node.parentId,
      key: node.key,
      before,
      after: value,
      actor: opts.owner,
      ts: this.deps.clock.now(),
    });
  }
```

Replace the existing `insert` method with (adds `onChange` on the new child after `bump`):

```ts
  insert(parentRef: Ref, keyOrIndex: string | number, value: Json, opts: MutateOpts = {}): NodeId {
    const parent = this.resolve(parentRef);
    this.checkScope(parent, opts.writeScope);
    this.checkVersion(parent, opts.ifVersion);
    const type = opts.type;
    this.deps.validate?.({ node: null, proposed: value, type, op: "insert" });
    const newId = this.tree.insertChild(parent.id, keyOrIndex, value, type);
    const child = this.tree.get(newId)!;
    if (opts.tags !== undefined) child.tags = opts.tags;
    this.bump(parent, opts.owner);
    this.deps.onChange?.(child);
    this.log.append({
      kind: "insert",
      targetId: newId,
      parentId: parent.id,
      key: child.key,
      after: value,
      actor: opts.owner,
      ts: this.deps.clock.now(),
    });
    return newId;
  }
```

Replace the existing `remove` method with (adds `onRemove` after `removeChild`/`bump`):

```ts
  remove(ref: Ref, opts: MutateOpts = {}): void {
    const node = this.resolve(ref);
    if (node.parentId === null) throw new InvalidOpError("cannot remove the root");
    this.checkScope(node, opts.writeScope);
    this.checkVersion(node, opts.ifVersion);
    const before = this.tree.toJson(node.id);
    const parent = this.tree.get(node.parentId)!;
    const removedKey = node.key;
    this.tree.removeChild(node.parentId, node.id);
    this.bump(parent, opts.owner);
    this.deps.onRemove?.(node.id);
    this.log.append({
      kind: "remove",
      targetId: node.id,
      parentId: parent.id,
      key: removedKey,
      before,
      actor: opts.owner,
      ts: this.deps.clock.now(),
    });
  }
```

(Do NOT modify `move` — content is unchanged on a move, so the embedding stays valid; no hook fires.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/mutator-hooks.test.ts`
Expected: PASS (4 tests). Then `npx vitest run` — confirm NO regressions (existing Mutator tests don't pass `onChange`/`onRemove`, so the optional `?.` calls are no-ops).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/mutator.ts test/mutator-hooks.test.ts
git commit -m "feat: Mutator onChange/onRemove hooks (set/insert/remove; not move)"
```

---

### Task 6: `SemanticIndex.search`

**Files:**
- Modify: `src/semantic-index.ts` (add `SearchOpts`/`SearchResult`/`SearchHit` types + `search` method + a private `snippetOf`; do NOT change the lifecycle methods)
- Test: `test/semantic-search.test.ts`

- [ ] **Step 1: Write the failing test `test/semantic-search.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { SemanticIndex } from "../src/semantic-index";
import { MockEmbeddingPort } from "../src/embedding-port";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function setup() {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson({ docs: {} }, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const index = new SemanticIndex(tree, addressing, new MockEmbeddingPort(), new MemoryVectorIndex());
  const mutator = new Mutator(tree, addressing, log, { clock, ...index.hooks() });
  return { tree, addressing, index, mutator };
}

describe("SemanticIndex.search", () => {
  it("ranks the node whose text matches the query first", async () => {
    const { index, mutator } = setup();
    mutator.insert({ path: "/docs" }, "a", "the quick brown fox");
    mutator.insert({ path: "/docs" }, "b", "lorem ipsum dolor");
    await index.reindex();
    const r = await index.search("the quick brown fox");
    expect(r.results[0].path).toBe("/docs/a");
    expect(r.results[0].score).toBeCloseTo(1, 5);
    expect(r.staleCount).toBe(0);
  });

  it("best-effort search reports staleCount without reindexing", async () => {
    const { index, mutator } = setup();
    mutator.insert({ path: "/docs" }, "a", "hello");
    const r = await index.search("hello"); // not reindexed yet
    expect(r.staleCount).toBe(1);
    expect(r.results.length).toBe(0); // nothing indexed yet
  });

  it("freshness 'wait' reindexes before searching", async () => {
    const { index, mutator } = setup();
    mutator.insert({ path: "/docs" }, "a", "hello");
    const r = await index.search("hello", { freshness: "wait" });
    expect(r.staleCount).toBe(0);
    expect(r.results[0].path).toBe("/docs/a");
  });

  it("respects k", async () => {
    const { index, mutator } = setup();
    mutator.insert({ path: "/docs" }, "a", "alpha text");
    mutator.insert({ path: "/docs" }, "b", "beta text");
    mutator.insert({ path: "/docs" }, "c", "gamma text");
    await index.reindex();
    const r = await index.search("text", { k: 2 });
    expect(r.results.length).toBe(2);
  });

  it("post-filters by under (JSON-Pointer prefix)", async () => {
    const { index, mutator, tree, addressing } = setup();
    mutator.insert({ path: "" }, "other", {}, {}); // sibling container
    mutator.insert({ path: "/docs" }, "a", "shared text");
    mutator.insert({ path: "/other" }, "b", "shared text");
    await index.reindex();
    const r = await index.search("shared text", { under: "/docs" });
    expect(r.results.every((h) => h.path.startsWith("/docs"))).toBe(true);
    expect(r.results.map((h) => h.path)).toContain("/docs/a");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/semantic-search.test.ts`
Expected: FAIL — `index.search is not a function`.

- [ ] **Step 3: Modify `src/semantic-index.ts`**

Add this import line at the top (with the other imports):

```ts
import type { Json } from "./types";
```

Add these exported types after the imports (before `export class SemanticIndex`):

```ts
export interface SearchOpts {
  k?: number;
  under?: string;
  type?: string;
  tag?: string;
  freshness?: "best-effort" | "wait";
}

export interface SearchHit {
  id: NodeId;
  path: string;
  type?: string;
  score: number;
  snippet: string;
}

export interface SearchResult {
  results: SearchHit[];
  staleCount: number;
}
```

Add these methods INSIDE the `SemanticIndex` class, before its closing brace (after `reindex`):

```ts
  private snippetOf(value: Json): string {
    const s = JSON.stringify(value);
    return s.length <= 80 ? s : s.slice(0, 80) + "…";
  }

  /**
   * Semantic search: embed the query, rank indexed nodes by cosine, post-filter by
   * under/type/tag, return top-k. `freshness: "wait"` flushes the reindexer first;
   * default `best-effort` searches what's indexed and reports `staleCount`.
   */
  async search(queryText: string, opts: SearchOpts = {}): Promise<SearchResult> {
    if (opts.freshness === "wait") await this.reindex();
    const k = opts.k ?? 8;
    const [queryVec] = await this.embedding.embed([queryText]);
    const ranked = this.vectors.search(queryVec, this.vectors.size());
    const results: SearchHit[] = [];
    for (const hit of ranked) {
      if (results.length >= k) break;
      const node = this.tree.get(hit.nodeId);
      if (!node) continue;
      const path = this.addressing.pathOf(node.id);
      if (opts.under !== undefined && path !== opts.under && !path.startsWith(opts.under + "/")) continue;
      if (opts.type !== undefined && node.type !== opts.type) continue;
      if (opts.tag !== undefined && !(node.tags?.includes(opts.tag) ?? false)) continue;
      results.push({
        id: node.id,
        path,
        type: node.type,
        score: hit.score,
        snippet: this.snippetOf(this.tree.toJson(node.id)),
      });
    }
    return { results, staleCount: this.staleCount() };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/semantic-search.test.ts`
Expected: PASS (5 tests). Then `npx vitest run` — no regressions.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/semantic-index.ts test/semantic-search.test.ts
git commit -m "feat: SemanticIndex.search with freshness modes and under/type/tag filters"
```

---

### Task 7: Capstone — embed, mutate, reindex, search end-to-end

**Files:**
- Test: `test/m5-semantic.test.ts` (test-only; wires registry+embedText, Mutator+index hooks, mutates, searches)

- [ ] **Step 1: Write the failing test `test/m5-semantic.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { SemanticIndex } from "../src/semantic-index";
import { MockEmbeddingPort } from "../src/embedding-port";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { TypeRegistry } from "../src/type-registry";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function setup() {
  const registry = new TypeRegistry();
  // a PageContent type embeds its title+body (a container node would otherwise embed as null)
  registry.register("PageContent", {
    embedText: (v) => {
      const o = v as { title?: string; body?: string };
      return `${o.title ?? ""} ${o.body ?? ""}`.trim();
    },
  });
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson({ pages: {} }, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const index = new SemanticIndex(tree, addressing, new MockEmbeddingPort(), new MemoryVectorIndex(), registry);
  const mutator = new Mutator(tree, addressing, log, { clock, ...index.hooks() });
  return { tree, addressing, index, mutator };
}

describe("M5 semantic integration", () => {
  it("indexes typed pages via embedText and finds the right one by meaning", async () => {
    const { index, mutator } = setup();
    mutator.insert({ path: "/pages" }, "home", { title: "Welcome home", body: "intro" }, { type: "PageContent" });
    mutator.insert({ path: "/pages" }, "pricing", { title: "Pricing plans", body: "cost" }, { type: "PageContent" });
    await index.reindex();
    const r = await index.search("Pricing plans cost");
    expect(r.results[0].path).toBe("/pages/pricing");
    expect(r.staleCount).toBe(0);
  });

  it("a set that changes content re-stales and reindex refreshes the vector", async () => {
    const { addressing, index, mutator } = setup();
    mutator.insert({ path: "/pages" }, "home", { title: "Old title", body: "x" }, { type: "PageContent" });
    await index.reindex();
    expect(index.staleCount()).toBe(0);
    const homeId = addressing.byPath("/pages/home")!.id;
    mutator.set({ id: homeId }, { title: "Brand new headline", body: "x" }, { type: "PageContent" });
    expect(index.staleCount()).toBe(1); // content changed → stale again
    await index.reindex();
    const r = await index.search("Brand new headline", { freshness: "wait" });
    expect(r.results[0].path).toBe("/pages/home");
  });

  it("removing a page drops it from search results", async () => {
    const { addressing, index, mutator } = setup();
    mutator.insert({ path: "/pages" }, "home", { title: "Home", body: "h" }, { type: "PageContent" });
    mutator.insert({ path: "/pages" }, "gone", { title: "Temporary", body: "t" }, { type: "PageContent" });
    await index.reindex();
    const goneId = addressing.byPath("/pages/gone")!.id;
    mutator.remove({ id: goneId });
    const r = await index.search("Temporary", { freshness: "wait" });
    expect(r.results.map((h) => h.path)).not.toContain("/pages/gone");
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `npx vitest run test/m5-semantic.test.ts`
Expected: PASS — every piece was built in Tasks 1–6. (If it fails, fix the corresponding source from the earlier task, not this test.)

> Note on `embedText` for a decomposed container: with `sizeBasedDecision(1)` the inserted `{title, body}` decomposes into an object node typed `PageContent`. `onChange` is fired on that container node; `toEmbeddingText` sees a non-leaf node but the type's `embedText` wins, so the container IS embedded from its reconstructed value. This is the intended type-aware-over-container behavior.

- [ ] **Step 3: Run the full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all suites pass; no type errors.

- [ ] **Step 4: Commit**

```bash
git add test/m5-semantic.test.ts
git commit -m "test: M5 semantic end-to-end (embedText, reindex, search, re-stale, remove)"
```

---

## Milestone 5 — Definition of Done

- [ ] `npm test` — all suites pass (M1–M5).
- [ ] `npm run typecheck` — no errors.
- [ ] You can: wire a `SemanticIndex` into the `Mutator` via `index.hooks()`; mutations mark affected nodes stale (with `textHash` dedupe; `move` does not); `reindex()` embeds stale nodes in one batch and marks them fresh; `search(queryText, {k, under, type, tag, freshness})` returns top-k by cosine with `staleCount`, and `freshness: "wait"` flushes first; a type's `embedText` controls what (even a container) gets embedded.

---

## Roadmap: subsequent plans

- **M6 — Storage:** `StoragePort` (in-memory + file-snapshot); persist tree + vectors; restore (the vector index is derived/rebuildable, so a snapshot can store vectors or recompute).
- **M7 — Replay**, **M8 — Toolset** (the scoped `makeToolset` exposes `search` alongside `describe`/`get`/`find`/`patch`/`history`; serialize `meta` at the boundary), **M9 — Scenario**. (See the M1 plan roadmap.)

---

## Self-Review (against the spec)

**Spec coverage (this plan):** §7 semantic channel — `EmbeddingPort` (Task 1), `VectorIndexPort` brute-force (Task 2), `toEmbeddingText` + `textHash` + type `embedText` (Task 3), co-located stale lifecycle (`meta.embedding`) + dedupe + `move`-doesn't-invalidate (Tasks 4–5), async batched reindexer (Task 4), `search` with `best-effort`/`wait` + `staleCount` + `under`/`type`/`tag` filters (Task 6), end-to-end (Task 7). Mutation→stale wiring via `MutatorDeps` hooks (Task 5). Deferred items (real providers, pgvector/sqlite-vec, vector persistence, ANN, toolset `search` exposure) listed in Scope.

**Placeholder scan:** No TBD/TODO; every code step has full code; every run step has an exact command + expected result. Task 7 step 2 is a "should already pass" capstone with rationale (not a placeholder).

**Type consistency:** `EmbeddingPort` (`dims`, `embed(texts): Promise<number[][]>`) defined in Task 1, consumed by `SemanticIndex` (Tasks 4, 6) and `reindex`/`search`. `VectorIndexPort` (`upsert`/`remove`/`search`/`has`/`size`) + `VectorIndexEntry`/`VectorHit` defined in Task 2, consumed by `SemanticIndex`. `toEmbeddingText(node, value, typeDef?)`/`textHash(text)` defined in Task 3, used in Tasks 4, 6. `TypeDef.embedText?: (value: Json) => string | null` (Task 3) is read by `toEmbeddingText`. `MutatorDeps.onChange?(node)`/`onRemove?(nodeId)` (Task 5) are produced by `SemanticIndex.hooks()` (Task 4) — signatures match (`(node: ArbNode) => void`, `(nodeId: NodeId) => void`). `meta.embedding` shape `{state:"fresh"|"stale"|"none"; textHash?; vecRef?}` is the pre-existing `NodeMeta` field (M1 `types.ts`) — M5 writes `state`+`textHash` (never `vecRef`, reserved). `SearchOpts`/`SearchHit`/`SearchResult` defined in Task 6, used in Tasks 6–7. `SemanticIndex` constructor `(tree, addressing, embedding, vectors, registry?)` is consistent across Tasks 4, 6, 7.
