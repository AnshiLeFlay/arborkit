# Arbor — M4: Navigator & Exact Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the agent-facing read tools — `describe` (cheap structural listing), `get` (bounded content), and `find` (exact lookup by `type` / `tag` / glob `pathPattern`) — plus tag assignment so `find({tag})` is functional.

**Architecture:** A new read-only `Navigator(tree, addressing)` exposes `describe`/`get`/`find`. `describe` lists a node's direct children with cheap summaries (kind, type, hasChildren, size, preview) and pagination — it never reconstructs deep subtrees. `get` reconstructs a node's JSON bounded by `maxDepth` (deeper subtrees become a truncation marker). `find` walks the tree and matches nodes by exact `type`, `tag` membership, or a JSON-Pointer glob (`*` = one segment, `**` = any depth). M4 implements `find` as a tree scan (O(n), correct and simple at current scale); a maintained tag/type index is a deferred optimization. Tag assignment is a tiny additive change to `Mutator.set`/`insert` (`MutateOpts.tags`), since tags are metadata that don't affect decomposition.

**Tech Stack:** Node ≥20.6, TypeScript (ESM, strict), Vitest. No new dependencies. Builds on M1–M3.

---

## Scope of THIS plan (Milestone 4)

Covers spec §6 (`describe`/`get`/`find`, bounding/pagination, self-describing results) and §7-exact (lookup by id/path/tag/type) and §10.4. Produces working, testable software: an agent can navigate the tree cheaply, read bounded content, and find nodes by type/tag/path.

**Out of scope here (later milestones):** `search` (semantic/vector — M5), `patch`/`history` tools (the toolset wrapper is M8; the underlying mutate/version already exist in M2/M7), per-node embeddings (M5), storage (M6), replay engine (M7), the scoped `makeToolset` + LangChain wrappers (M8). Also deferred within M4: nested `describe` depth>1 (agents navigate deeper by calling `describe` on a child — `hasChildren` signals where), `get` `maxBytes` byte-budget (only `maxDepth` structural bound is built), and a maintained tag/type index (find scans).

## Design decisions (locked for M4)

1. **`find` scans the tree** (DFS from root via `children`), matching by `type` (exact, from M3), `tag` (membership in `node.tags`), and `pathPattern` (glob over the derived JSON Pointer). Multiple selector fields are AND-ed. Correct and simple at current scale; the "synchronous tag/type map" from spec §7 is a deferred performance optimization (documented).
2. **Tag assignment** is additive on the `Mutator`: `MutateOpts.tags` stamps `node.tags` in `set`/`insert` AFTER the structural op (tags don't affect decomposition, so they don't go through `build`/`isOpaque` like `type` does). Omitting `tags` leaves existing tags untouched.
3. **`describe` is cheap**: direct children only (depth 1), each summarized with O(1)-ish data (`childIds.length`, a leaf's `byteSize`, a short `preview`) — never a deep `toJson`. Pagination via `offset`/`limit` with an explicit `truncated` report (no silent capping).
4. **`get` bounds by `maxDepth`**: reconstructs to N levels; deeper containers become a string marker and `truncated: true` is set. `maxBytes` deferred.
5. **glob `pathPattern`**: `*` matches exactly one path segment, `**` matches zero or more segments. Matching is on the parsed JSON-Pointer segment arrays.

## File Structure (Milestone 4)

- Create: `src/path-glob.ts` — `matchGlob(pattern, path): boolean` (segment-array glob over JSON Pointer).
- Modify: `src/mutator.ts` — add `tags?: string[]` to `MutateOpts`; stamp tags in `set`/`insert` (no other method changes).
- Create: `src/navigator.ts` — `Navigator` (`describe`/`get`/`find`) + result types + private helpers (`resolve`, `summarize`, `previewOf`, `matches`).
- Test: `test/path-glob.test.ts`, `test/mutator-tags.test.ts`, `test/navigator-describe-get.test.ts`, `test/navigator-find.test.ts`, `test/m4-navigator.test.ts`.

---

### Task 1: `matchGlob` (JSON-Pointer glob)

**Files:**
- Create: `src/path-glob.ts`
- Test: `test/path-glob.test.ts`

- [ ] **Step 1: Write the failing test `test/path-glob.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { matchGlob } from "../src/path-glob";

describe("matchGlob", () => {
  it("matches a single-segment wildcard", () => {
    expect(matchGlob("/pages/*", "/pages/0")).toBe(true);
    expect(matchGlob("/pages/*", "/pages/home")).toBe(true);
  });

  it("does not let a single wildcard span multiple segments", () => {
    expect(matchGlob("/pages/*", "/pages/0/title")).toBe(false);
  });

  it("matches a wildcard in the middle", () => {
    expect(matchGlob("/pages/*/title", "/pages/0/title")).toBe(true);
    expect(matchGlob("/pages/*/title", "/pages/0/body")).toBe(false);
  });

  it("matches ** across any depth, including zero segments", () => {
    expect(matchGlob("/pages/**", "/pages")).toBe(true);
    expect(matchGlob("/pages/**", "/pages/0")).toBe(true);
    expect(matchGlob("/pages/**", "/pages/0/title")).toBe(true);
    expect(matchGlob("/**", "/a/b/c")).toBe(true);
  });

  it("matches the root pattern to the root path", () => {
    expect(matchGlob("", "")).toBe(true);
  });

  it("rejects a literal mismatch", () => {
    expect(matchGlob("/a", "/b")).toBe(false);
    expect(matchGlob("/a/b", "/a")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/path-glob.test.ts`
Expected: FAIL — cannot resolve `../src/path-glob`.

- [ ] **Step 3: Write `src/path-glob.ts`**

```ts
import { parsePointer } from "./jsonpointer";

/** Match parsed segment arrays. `*` = one segment; `**` = zero or more segments. */
function matchSegments(pattern: string[], path: string[]): boolean {
  if (pattern.length === 0) return path.length === 0;
  const [head, ...rest] = pattern;
  if (head === "**") {
    for (let i = 0; i <= path.length; i++) {
      if (matchSegments(rest, path.slice(i))) return true;
    }
    return false;
  }
  if (path.length === 0) return false;
  if (head === "*" || head === path[0]) {
    return matchSegments(rest, path.slice(1));
  }
  return false;
}

/**
 * Glob-match a JSON Pointer `path` against a `pattern`.
 * `*` matches exactly one path segment; `**` matches zero or more segments.
 */
export function matchGlob(pattern: string, path: string): boolean {
  return matchSegments(parsePointer(pattern), parsePointer(path));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/path-glob.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/path-glob.ts test/path-glob.test.ts
git commit -m "feat: matchGlob JSON-Pointer glob (* segment, ** any depth)"
```

---

### Task 2: Tag assignment on the `Mutator`

**Files:**
- Modify: `src/mutator.ts` (add `tags?` to `MutateOpts`; replace `set` and `insert`; no other method changes)
- Test: `test/mutator-tags.test.ts`

- [ ] **Step 1: Write the failing test `test/mutator-tags.test.ts`**

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
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(3) };
  const tree = ArtifactTree.fromJson(json as never, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock });
  return { tree, addressing, log, mutator };
}

describe("Mutator tag assignment", () => {
  it("insert with tags stamps them on the new node", () => {
    const { tree, mutator } = setup({ a: 1 });
    const id = mutator.insert({ path: "" }, "b", 2, { tags: ["x", "y"] });
    expect(tree.get(id)!.tags).toEqual(["x", "y"]);
  });

  it("set with tags stamps them on the node", () => {
    const { addressing, mutator } = setup({ a: 1 });
    mutator.set({ path: "/a" }, 2, { tags: ["t"] });
    expect(addressing.byPath("/a")!.tags).toEqual(["t"]);
  });

  it("leaves existing tags untouched when opts.tags is omitted", () => {
    const { addressing, mutator } = setup({ a: 1 });
    mutator.set({ path: "/a" }, 2, { tags: ["t"] });
    mutator.set({ path: "/a" }, 3);
    expect(addressing.byPath("/a")!.tags).toEqual(["t"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mutator-tags.test.ts`
Expected: FAIL — `MutateOpts` has no `tags`; tags not stamped.

- [ ] **Step 3: Modify `src/mutator.ts`**

Replace the existing `MutateOpts` interface with:

```ts
export interface MutateOpts {
  owner?: string;
  /** JSON Pointer prefix; the target must be at or under it. */
  writeScope?: string;
  /** Optimistic concurrency: reject unless the target's current version equals this. */
  ifVersion?: number;
  /** Register/override the node's type (drives validation and the decompose override). */
  type?: string;
  /** Replace the node's tags (identity labels for exact `find` by tag). */
  tags?: string[];
}
```

Replace the existing `set` method with (adds the tag stamp after `replaceValue`):

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

Replace the existing `insert` method with (stamps tags on the new child):

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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/mutator-tags.test.ts`
Expected: PASS (3 tests). Then `npx vitest run` — confirm NO regressions (M2/M3 mutator tests omit `opts.tags`, so behavior is unchanged).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/mutator.ts test/mutator-tags.test.ts
git commit -m "feat: Mutator tag assignment via MutateOpts.tags"
```

---

### Task 3: `Navigator` — `describe` + `get`

**Files:**
- Create: `src/navigator.ts`
- Test: `test/navigator-describe-get.test.ts`

- [ ] **Step 1: Write the failing test `test/navigator-describe-get.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { Navigator } from "../src/navigator";
import { NodeNotFoundError } from "../src/errors";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function makeNav(json: unknown) {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(3) };
  const tree = ArtifactTree.fromJson(json as never, deps);
  const addressing = new Addressing(tree);
  return { tree, addressing, nav: new Navigator(tree, addressing) };
}

describe("Navigator.describe", () => {
  it("lists direct children with summaries and the node's own path", () => {
    const { nav } = makeNav({ a: { b: 1 }, d: [10, 20] });
    const r = nav.describe();
    expect(r.node.path).toBe("");
    expect(r.node.kind).toBe("object");
    expect(r.children.map((c) => c.key)).toEqual(["a", "d"]);
    const a = r.children.find((c) => c.key === "a")!;
    expect(a.kind).toBe("object");
    expect(a.hasChildren).toBe(true);
    expect(a.size).toBe(1); // one child key
  });

  it("summarizes a leaf with a preview and zero hasChildren", () => {
    const { nav } = makeNav({ title: "Home" });
    const r = nav.describe();
    const t = r.children.find((c) => c.key === "title")!;
    expect(t.kind).toBe("leaf");
    expect(t.hasChildren).toBe(false);
    expect(t.preview).toContain("Home");
  });

  it("paginates with offset/limit and reports truncated", () => {
    const { nav } = makeNav({ a: 1, b: 2, c: 3 });
    const r = nav.describe({ path: "" }, { limit: 2 });
    expect(r.children.map((c) => c.key)).toEqual(["a", "b"]);
    expect(r.truncated).toEqual({ shown: 2, total: 3, nextOffset: 2 });
    const r2 = nav.describe({ path: "" }, { offset: 2, limit: 2 });
    expect(r2.children.map((c) => c.key)).toEqual(["c"]);
    expect(r2.truncated).toBeUndefined();
  });

  it("throws NodeNotFoundError for a missing ref", () => {
    const { nav } = makeNav({ a: 1 });
    expect(() => nav.describe({ path: "/nope" })).toThrow(NodeNotFoundError);
  });
});

describe("Navigator.get", () => {
  it("returns the full reconstructed content by default", () => {
    const { nav } = makeNav({ a: { b: 1 }, d: [10, 20] });
    const r = nav.get({ path: "" });
    expect(r.content).toEqual({ a: { b: 1 }, d: [10, 20] });
    expect(r.path).toBe("");
    expect(r.truncated).toBeUndefined();
  });

  it("bounds depth: deeper containers become a truncation marker and truncated=true", () => {
    const { nav } = makeNav({ a: { b: { c: 1 } } });
    const r = nav.get({ path: "" }, { maxDepth: 1 });
    expect(r.truncated).toBe(true);
    // root (depth 0) expanded; child 'a' (depth 1) container truncated
    expect(typeof (r.content as Record<string, unknown>).a).toBe("string");
  });

  it("returns a leaf's content directly", () => {
    const { nav } = makeNav({ title: "Home" });
    const r = nav.get({ path: "/title" });
    expect(r.content).toBe("Home");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/navigator-describe-get.test.ts`
Expected: FAIL — cannot resolve `../src/navigator`.

- [ ] **Step 3: Write `src/navigator.ts`**

```ts
import type { ArbNode, Json, NodeId, NodeKind, NodeMeta } from "./types";
import type { ArtifactTree } from "./artifact-tree";
import type { Addressing } from "./addressing";
import { type Ref, NodeNotFoundError } from "./errors";
import { byteSize } from "./decompose";

const DEFAULT_LIMIT = 100;
const PREVIEW_MAX = 50;

export interface NodeSummary {
  id: NodeId;
  path: string;
  key: string | number | null;
  kind: NodeKind;
  type?: string;
}

export interface ChildSummary {
  id: NodeId;
  key: string | number | null;
  kind: NodeKind;
  type?: string;
  hasChildren: boolean;
  size: number;
  preview: string;
}

export interface DescribeOpts {
  offset?: number;
  limit?: number;
}

export interface DescribeResult {
  node: NodeSummary;
  children: ChildSummary[];
  truncated?: { shown: number; total: number; nextOffset: number };
}

export interface GetOpts {
  maxDepth?: number;
}

export interface GetResult {
  id: NodeId;
  path: string;
  type?: string;
  content: Json;
  meta: NodeMeta;
  truncated?: boolean;
}

function previewOf(node: ArbNode): string {
  if (node.kind === "leaf") {
    const s = JSON.stringify(node.content);
    return s.length <= PREVIEW_MAX ? s : s.slice(0, PREVIEW_MAX) + "…";
  }
  return node.kind === "array" ? `[${node.childIds.length} items]` : `{${node.childIds.length} keys}`;
}

/** Read-only navigation over the artifact tree: describe (cheap listing) and get (bounded content). */
export class Navigator {
  constructor(
    private readonly tree: ArtifactTree,
    private readonly addressing: Addressing,
  ) {}

  protected resolve(ref: Ref): ArbNode {
    const node = "id" in ref ? this.addressing.byId(ref.id) : this.addressing.byPath(ref.path);
    if (!node) throw new NodeNotFoundError(ref);
    return node;
  }

  private summarize(node: ArbNode): ChildSummary {
    return {
      id: node.id,
      key: node.key,
      kind: node.kind,
      type: node.type,
      hasChildren: node.childIds.length > 0,
      size: node.kind === "leaf" ? byteSize(node.content) : node.childIds.length,
      preview: previewOf(node),
    };
  }

  describe(ref: Ref = { path: "" }, opts: DescribeOpts = {}): DescribeResult {
    const node = this.resolve(ref);
    const all = this.tree.children(node.id);
    const total = all.length;
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const page = all.slice(offset, offset + limit);
    const result: DescribeResult = {
      node: {
        id: node.id,
        path: this.addressing.pathOf(node.id),
        key: node.key,
        kind: node.kind,
        type: node.type,
      },
      children: page.map((c) => this.summarize(c)),
    };
    const nextOffset = offset + page.length;
    if (nextOffset < total) {
      result.truncated = { shown: page.length, total, nextOffset };
    }
    return result;
  }

  get(ref: Ref, opts: GetOpts = {}): GetResult {
    const node = this.resolve(ref);
    const maxDepth = opts.maxDepth;
    let truncated = false;
    const reconstruct = (id: NodeId, depth: number): Json => {
      const n = this.tree.get(id)!;
      if (n.kind === "leaf") return n.content;
      if (maxDepth !== undefined && depth >= maxDepth) {
        truncated = true;
        const label = n.kind === "array" ? `${n.childIds.length} items` : `${n.childIds.length} keys`;
        return `[truncated: ${label}]`;
      }
      if (n.kind === "array") return n.childIds.map((cid) => reconstruct(cid, depth + 1));
      const obj: Record<string, Json> = {};
      for (const cid of n.childIds) {
        const c = this.tree.get(cid)!;
        obj[String(c.key)] = reconstruct(cid, depth + 1);
      }
      return obj;
    };
    const content = reconstruct(node.id, 0);
    const result: GetResult = {
      id: node.id,
      path: this.addressing.pathOf(node.id),
      type: node.type,
      content,
      meta: node.meta,
    };
    if (truncated) result.truncated = true;
    return result;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/navigator-describe-get.test.ts`
Expected: PASS (7 tests). Then `npx vitest run` — no regressions.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/navigator.ts test/navigator-describe-get.test.ts
git commit -m "feat: Navigator describe (cheap listing) and get (depth-bounded content)"
```

---

### Task 4: `Navigator` — `find`

**Files:**
- Modify: `src/navigator.ts` (add `find` + the `matches` helper + result/selector types + the `matchGlob` import; no other method changes)
- Test: `test/navigator-find.test.ts`

- [ ] **Step 1: Write the failing test `test/navigator-find.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { Navigator } from "../src/navigator";
import { Mutator } from "../src/mutator";
import { EventLog } from "../src/event-log";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function makeAll(json: unknown) {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(3) };
  const tree = ArtifactTree.fromJson(json as never, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock });
  const nav = new Navigator(tree, addressing);
  return { tree, addressing, mutator, nav };
}

describe("Navigator.find", () => {
  it("finds nodes by exact type", () => {
    const { mutator, nav } = makeAll({ items: {} });
    mutator.insert({ path: "/items" }, "x", { v: 1 }, { type: "Widget" });
    mutator.insert({ path: "/items" }, "y", { v: 2 }, { type: "Widget" });
    mutator.insert({ path: "/items" }, "z", { v: 3 }, { type: "Other" });
    const hits = nav.find({ type: "Widget" });
    expect(hits.map((h) => h.path).sort()).toEqual(["/items/x", "/items/y"]);
    expect(hits.every((h) => h.type === "Widget")).toBe(true);
  });

  it("finds nodes by tag membership", () => {
    const { mutator, nav } = makeAll({ facts: {} });
    mutator.insert({ path: "/facts" }, "price", "2990", { tags: ["brand-fact:price"] });
    mutator.insert({ path: "/facts" }, "name", "Acme", { tags: ["brand-fact:name"] });
    const hits = nav.find({ tag: "brand-fact:price" });
    expect(hits.map((h) => h.path)).toEqual(["/facts/price"]);
  });

  it("finds nodes by glob pathPattern", () => {
    const { nav } = makeAll({ pages: { home: { t: 1 }, about: { t: 2 } } });
    const hits = nav.find({ pathPattern: "/pages/*" });
    expect(hits.map((h) => h.path).sort()).toEqual(["/pages/about", "/pages/home"]);
  });

  it("ANDs multiple selector fields", () => {
    const { mutator, nav } = makeAll({ pages: {} });
    mutator.insert({ path: "/pages" }, "a", { v: 1 }, { type: "Page", tags: ["draft"] });
    mutator.insert({ path: "/pages" }, "b", { v: 2 }, { type: "Page" });
    const hits = nav.find({ type: "Page", tag: "draft" });
    expect(hits.map((h) => h.path)).toEqual(["/pages/a"]);
  });

  it("respects the limit", () => {
    const { mutator, nav } = makeAll({ items: {} });
    mutator.insert({ path: "/items" }, "a", 1, { type: "T" });
    mutator.insert({ path: "/items" }, "b", 2, { type: "T" });
    mutator.insert({ path: "/items" }, "c", 3, { type: "T" });
    expect(nav.find({ type: "T" }, { limit: 2 }).length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/navigator-find.test.ts`
Expected: FAIL — `nav.find is not a function`.

- [ ] **Step 3: Modify `src/navigator.ts`**

Add the `matchGlob` import. Change the existing errors/decompose import block so the top imports include `matchGlob`; specifically add this line with the other imports:

```ts
import { matchGlob } from "./path-glob";
```

Add these exported types near the other result types (after `GetResult`):

```ts
export interface FindSelector {
  type?: string;
  tag?: string;
  pathPattern?: string;
}

export interface FindOpts {
  limit?: number;
}

export interface FindHit {
  id: NodeId;
  path: string;
  type?: string;
}
```

Add these two methods INSIDE the `Navigator` class, before its closing brace (after `get`):

```ts
  private matches(node: ArbNode, sel: FindSelector): boolean {
    if (sel.type !== undefined && node.type !== sel.type) return false;
    if (sel.tag !== undefined && !(node.tags?.includes(sel.tag) ?? false)) return false;
    if (sel.pathPattern !== undefined && !matchGlob(sel.pathPattern, this.addressing.pathOf(node.id))) {
      return false;
    }
    return true;
  }

  /** Find nodes matching ALL provided selector fields (exact `type`, `tag` membership, glob `pathPattern`). */
  find(selector: FindSelector, opts: FindOpts = {}): FindHit[] {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const hits: FindHit[] = [];
    const visit = (id: NodeId): void => {
      if (hits.length >= limit) return;
      const node = this.tree.get(id)!;
      if (this.matches(node, selector)) {
        hits.push({ id: node.id, path: this.addressing.pathOf(node.id), type: node.type });
      }
      for (const cid of node.childIds) {
        if (hits.length >= limit) break;
        visit(cid);
      }
    };
    visit(this.tree.rootIdValue());
    return hits;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/navigator-find.test.ts`
Expected: PASS (5 tests). Then `npx vitest run` — no regressions.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/navigator.ts test/navigator-find.test.ts
git commit -m "feat: Navigator find by type/tag/pathPattern (tree scan)"
```

---

### Task 5: Capstone — navigate a content-generator-shaped artifact

**Files:**
- Test: `test/m4-navigator.test.ts` (test-only; builds a typed/tagged site via the Mutator, then queries it via the Navigator)

- [ ] **Step 1: Write the failing test `test/m4-navigator.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { Navigator } from "../src/navigator";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function setup() {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(3) };
  const tree = ArtifactTree.fromJson({ pages: {}, brandFacts: {} }, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock });
  const nav = new Navigator(tree, addressing);
  // build a small site
  mutator.insert({ path: "/pages" }, "home", { title: "Home", body: "<h1>Hi</h1>" }, { type: "PageContent" });
  mutator.insert({ path: "/pages" }, "about", { title: "About", body: "<p>Us</p>" }, { type: "PageContent" });
  mutator.insert({ path: "/brandFacts" }, "price", "2990", { tags: ["brand-fact:price"] });
  return { tree, addressing, mutator, nav };
}

describe("M4 navigator integration", () => {
  it("describe lists the top-level scaffold cheaply", () => {
    const { nav } = setup();
    const r = nav.describe();
    expect(r.children.map((c) => c.key).sort()).toEqual(["brandFacts", "pages"]);
  });

  it("find by type returns the page nodes", () => {
    const { nav } = setup();
    const hits = nav.find({ type: "PageContent" });
    expect(hits.map((h) => h.path).sort()).toEqual(["/pages/about", "/pages/home"]);
  });

  it("find by tag returns the brand fact", () => {
    const { nav } = setup();
    const hits = nav.find({ tag: "brand-fact:price" });
    expect(hits.map((h) => h.path)).toEqual(["/brandFacts/price"]);
  });

  it("find by glob returns the pages", () => {
    const { nav } = setup();
    const hits = nav.find({ pathPattern: "/pages/*" });
    expect(hits.map((h) => h.path).sort()).toEqual(["/pages/about", "/pages/home"]);
  });

  it("get returns a page's full content", () => {
    const { nav } = setup();
    const r = nav.get({ path: "/pages/home" });
    expect(r.type).toBe("PageContent");
    expect(r.content).toEqual({ title: "Home", body: "<h1>Hi</h1>" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `npx vitest run test/m4-navigator.test.ts`
Expected: PASS — every piece it relies on was built in Tasks 1–4. (If it fails, fix the corresponding source from the earlier task, not this test.)

> Note on the fixture: `sizeBasedDecision(3)` makes the small scaffold objects (`{ pages: {}, brandFacts: {} }`, `/pages`, `/brandFacts`) decompose into object nodes so children can be inserted; the inserted page objects (`{title, body}`) exceed 3 bytes and decompose too, so `find({type:"PageContent"})` returns the page container nodes (which carry the type), and `get` reconstructs their content.

- [ ] **Step 3: Run the full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all suites pass; no type errors.

- [ ] **Step 4: Commit**

```bash
git add test/m4-navigator.test.ts
git commit -m "test: M4 navigator end-to-end (describe/get/find over a typed+tagged site)"
```

---

## Milestone 4 — Definition of Done

- [ ] `npm test` — all suites pass (M1–M4).
- [ ] `npm run typecheck` — no errors.
- [ ] You can: `describe` a node to list its children cheaply (with pagination + `truncated`); `get` a node's content bounded by `maxDepth`; `find` nodes by exact `type`, `tag` membership, or glob `pathPattern`; and assign tags via `MutateOpts.tags`.

---

## Roadmap: subsequent plans

- **M5 — Semantic index:** `EmbeddingPort`/`VectorIndexPort`, `toEmbeddingText`, stale lifecycle + reindexer, `search` with freshness modes. (`TypeDef` gains `embedText`.) The Navigator gains/sees `search` alongside `find`.
- **M6 — Storage**, **M7 — Replay**, **M8 — Toolset** (wraps `describe`/`get`/`search`/`find`/`patch`/`history` as the scoped `makeToolset` + LangChain tools), **M9 — Scenario**. (See the M1 plan roadmap.)

---

## Self-Review (against the spec)

**Spec coverage (this plan):** §6 `describe` (cheap listing, child summaries, pagination, `truncated`) → Task 3; `get` (bounded content via `maxDepth`, `truncated`) → Task 3; `find` (exact `type`/`tag`/glob `pathPattern`, self-describing hits with id+path+type) → Task 4; glob `pathPattern` (`*`/`**`) → Task 1; tag assignment so `find({tag})` is functional → Task 2; end-to-end → Task 5. §7-exact id/path/tag/type lookup → `find` (Task 4) + existing `Addressing` byId/byPath (M1). Deferred items (`search`/semantic = M5, nested `describe` depth>1, `get` `maxBytes`, maintained tag/type index, toolset wrapper) explicitly listed in Scope.

**Placeholder scan:** No TBD/TODO; every code step has full code; every run step has an exact command + expected result. Task 5 step 2 is a "should already pass" capstone with rationale (not a placeholder).

**Type consistency:** `matchGlob(pattern, path): boolean` defined in Task 1, used by `Navigator.find`'s `matches` in Task 4. `MutateOpts.tags?: string[]` (Task 2) is read by `find`'s tag matching (Task 4) via `node.tags`. `Navigator` constructor `(tree, addressing)` (Task 3) is used unchanged in Task 4 (find added as a method) and Task 5. Result types `DescribeResult`/`ChildSummary`/`NodeSummary`/`GetResult`/`FindHit`/`FindSelector` are defined once (Tasks 3–4) and consumed in Task 5. `Ref` (`{id}|{path}`) and `NodeNotFoundError` reused from M2 `errors.ts`. `byteSize` reused from `decompose.ts`; `NodeKind`/`NodeMeta`/`Json`/`NodeId` from `types.ts`. `find` reads `node.type` (M3) and `node.tags` (M2 field, assigned in Task 2) — both present on `ArbNode`.
