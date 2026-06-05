# Arbor — M1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the read-side foundation of Arbor — decompose a JSON value into an in-memory node tree, and address any node by stable id or by JSON Pointer path.

**Architecture:** Pure, transport-agnostic TypeScript core (ports-and-adapters). This milestone delivers: deterministic `IdGen`/`Clock` ports, RFC 6901 JSON Pointer utilities, size-based decomposition policy, the `ArtifactTree` aggregate (build from JSON + reconstruct back), and `Addressing` (id↔path). No mutations, no index, no toolset yet — those are later milestones.

**Tech Stack:** Node ≥20.6, TypeScript (ESM, strict), Vitest. No runtime dependencies in this milestone.

---

## Scope of THIS plan (Milestone 1)

Covers spec §4 (`ArtifactTree`, `Addressing`, `Clock`/`IdGen` ports) and §5 (Node model, identity-vs-path, size-based decomposition). Produces working, testable software: you can load any JSON, walk its structure, address nodes by id/path, and reconstruct the JSON.

**Out of scope here (later milestones — see Roadmap):** mutations, event-log, schema/types, navigator tools, semantic index, storage adapters, replay, toolset.

## File Structure (Milestone 1)

- Create: `package.json` — project manifest, scripts, dev deps.
- Create: `tsconfig.json` — strict TS, bundler resolution, no-emit typecheck.
- Create: `vitest.config.ts` — test runner config.
- Create: `src/types.ts` — core types: `Json`, `NodeId`, `NodeKind`, `NodeMeta`, `ArbNode`.
- Create: `src/ids.ts` — `IdGen` port + `UuidIdGen` + `SeqIdGen` (test double).
- Create: `src/clock.ts` — `Clock` port + `SystemClock` + `FixedClock` (test double).
- Create: `src/jsonpointer.ts` — RFC 6901 encode/decode/build/parse.
- Create: `src/decompose.ts` — decomposition policy (`DecomposeDecision`, `sizeBasedDecision`, helpers).
- Create: `src/artifact-tree.ts` — `ArtifactTree` aggregate (build/get/children/toJson).
- Create: `src/addressing.ts` — `Addressing` (byId/pathOf/byPath).
- Test: mirror under `test/`.

Each file has one responsibility; ports are separated from the aggregate so later adapters/milestones slot in without touching the core.

---

### Task 1: Project scaffold & tooling

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Test: `test/smoke.test.ts`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "arbor",
  "version": "0.0.0",
  "type": "module",
  "private": true,
  "engines": { "node": ">=20.6" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Write the smoke test `test/smoke.test.ts`**

```ts
import { describe, it, expect } from "vitest";

describe("smoke", () => {
  it("runs the test harness", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`
Expected: dependencies installed, `node_modules/` and `package-lock.json` created, exit code 0.

- [ ] **Step 6: Run the smoke test to verify tooling**

Run: `npm test`
Expected: PASS — `1 passed (1)`.

- [ ] **Step 7: Add a `.gitignore`**

Create `.gitignore`:

```
node_modules/
dist/
*.log
```

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts test/smoke.test.ts .gitignore package-lock.json
git commit -m "chore: scaffold Arbor TS library (vitest, strict tsconfig)"
```

---

### Task 2: Core types + deterministic ports (`IdGen`, `Clock`)

**Files:**
- Create: `src/types.ts`
- Create: `src/ids.ts`
- Create: `src/clock.ts`
- Test: `test/ids.test.ts`

- [ ] **Step 1: Write `src/types.ts`** (declarations only — exercised by later tasks)

```ts
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export type NodeId = string;
export type NodeKind = "object" | "array" | "leaf";

export interface NodeMeta {
  version: number;
  updatedAt: number;
  owner?: string;
  embedding: { state: "fresh" | "stale" | "none"; textHash?: string; vecRef?: string };
}

export interface ArbNode {
  id: NodeId;
  parentId: NodeId | null;
  key: string | number | null; // null only for the root
  kind: NodeKind;
  content: Json | null; // leaf: the value/opaque subtree; object|array: null
  childIds: NodeId[]; // ordered children (order is significant for arrays)
  tags?: string[];
  type?: string;
  meta: NodeMeta;
}
```

- [ ] **Step 2: Write the failing test `test/ids.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

describe("SeqIdGen", () => {
  it("produces deterministic sequential ids", () => {
    const g = new SeqIdGen();
    expect([g.next(), g.next(), g.next()]).toEqual(["n0", "n1", "n2"]);
  });

  it("honors a custom prefix", () => {
    const g = new SeqIdGen("x");
    expect([g.next(), g.next()]).toEqual(["x0", "x1"]);
  });
});

describe("FixedClock", () => {
  it("returns a constant value until advanced", () => {
    const c = new FixedClock(100);
    expect(c.now()).toBe(100);
    expect(c.now()).toBe(100);
    c.advance(5);
    expect(c.now()).toBe(105);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/ids.test.ts`
Expected: FAIL — cannot resolve `../src/ids` / `../src/clock` (modules do not exist yet).

- [ ] **Step 4: Write `src/ids.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { NodeId } from "./types";

export interface IdGen {
  next(): NodeId;
}

export class UuidIdGen implements IdGen {
  next(): NodeId {
    return randomUUID();
  }
}

/** Deterministic test double: n0, n1, n2, ... */
export class SeqIdGen implements IdGen {
  private n = 0;
  constructor(private readonly prefix = "n") {}
  next(): NodeId {
    return `${this.prefix}${this.n++}`;
  }
}
```

- [ ] **Step 5: Write `src/clock.ts`**

```ts
export interface Clock {
  now(): number; // epoch milliseconds
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/** Deterministic test double: constant value, manually advanced. */
export class FixedClock implements Clock {
  constructor(private t = 0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/ids.test.ts`
Expected: PASS — 3 tests passed.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors, exit code 0.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/ids.ts src/clock.ts test/ids.test.ts
git commit -m "feat: core types and deterministic IdGen/Clock ports"
```

---

### Task 3: JSON Pointer utilities (RFC 6901)

**Files:**
- Create: `src/jsonpointer.ts`
- Test: `test/jsonpointer.test.ts`

- [ ] **Step 1: Write the failing test `test/jsonpointer.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { encodeSegment, decodeSegment, buildPointer, parsePointer } from "../src/jsonpointer";

describe("json pointer segments", () => {
  it("escapes ~ as ~0 and / as ~1 on encode", () => {
    expect(encodeSegment("a/b~c")).toBe("a~1b~0c");
  });

  it("unescapes ~1 to / and ~0 to ~ on decode", () => {
    expect(decodeSegment("a~1b~0c")).toBe("a/b~c");
  });
});

describe("buildPointer / parsePointer", () => {
  it("builds an empty pointer from no segments (root)", () => {
    expect(buildPointer([])).toBe("");
  });

  it("builds a pointer from mixed string/number segments", () => {
    expect(buildPointer(["pages", 0, "title"])).toBe("/pages/0/title");
  });

  it("parses the root pointer to an empty segment list", () => {
    expect(parsePointer("")).toEqual([]);
  });

  it("parses a pointer into decoded segments", () => {
    expect(parsePointer("/pages/0/title")).toEqual(["pages", "0", "title"]);
  });

  it("round-trips segments needing escapes", () => {
    expect(parsePointer(buildPointer(["a/b", "~x"]))).toEqual(["a/b", "~x"]);
  });

  it("throws on a non-root pointer that does not start with '/'", () => {
    expect(() => parsePointer("pages/0")).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/jsonpointer.test.ts`
Expected: FAIL — cannot resolve `../src/jsonpointer`.

- [ ] **Step 3: Write `src/jsonpointer.ts`**

```ts
/** Escape a single reference token per RFC 6901: ~ -> ~0, / -> ~1. */
export function encodeSegment(s: string): string {
  return s.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Unescape a single reference token per RFC 6901: ~1 -> /, then ~0 -> ~. */
export function decodeSegment(s: string): string {
  return s.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Build a JSON Pointer string. Empty segment list => "" (root). */
export function buildPointer(segments: ReadonlyArray<string | number>): string {
  if (segments.length === 0) return "";
  return "/" + segments.map((s) => encodeSegment(String(s))).join("/");
}

/** Parse a JSON Pointer into decoded segments. "" => [] (root). */
export function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new Error(`Invalid JSON Pointer (must be "" or start with "/"): ${pointer}`);
  }
  return pointer.slice(1).split("/").map(decodeSegment);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/jsonpointer.test.ts`
Expected: PASS — all tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/jsonpointer.ts test/jsonpointer.test.ts
git commit -m "feat: RFC 6901 JSON Pointer utilities"
```

---

### Task 4: Decomposition policy (size-based)

**Files:**
- Create: `src/decompose.ts`
- Test: `test/decompose.test.ts`

- [ ] **Step 1: Write the failing test `test/decompose.test.ts`**

```ts
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/decompose.test.ts`
Expected: FAIL — cannot resolve `../src/decompose`.

- [ ] **Step 3: Write `src/decompose.ts`**

```ts
import type { Json, NodeKind } from "./types";

/** Policy deciding whether a value is stored whole (opaque leaf) or split into child nodes. */
export interface DecomposeDecision {
  /** `type` is the optional registered node type (used by the by-type override in a later milestone). */
  isOpaque(value: Json, type?: string): boolean;
}

/** UTF-8 byte length of the JSON serialization of a value. */
export function byteSize(value: Json): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Structural kind of a value given whether it is being stored opaquely. */
export function kindOf(value: Json, opaque: boolean): NodeKind {
  if (opaque) return "leaf";
  return Array.isArray(value) ? "array" : "object";
}

/**
 * Default policy: scalars are always opaque leaves; containers stay opaque
 * while their serialized size is within `maxOpaqueBytes`, otherwise they split.
 */
export function sizeBasedDecision(maxOpaqueBytes: number): DecomposeDecision {
  return {
    isOpaque(value: Json): boolean {
      if (value === null || typeof value !== "object") return true;
      return byteSize(value) <= maxOpaqueBytes;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/decompose.test.ts`
Expected: PASS — all tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/decompose.ts test/decompose.test.ts
git commit -m "feat: size-based decomposition policy"
```

---

### Task 5: `ArtifactTree` aggregate (build from JSON + reconstruct)

**Files:**
- Create: `src/artifact-tree.ts`
- Test: `test/artifact-tree.test.ts`

- [ ] **Step 1: Write the failing test `test/artifact-tree.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";
import { sizeBasedDecision } from "../src/decompose";

function deps(maxOpaqueBytes: number): TreeDeps {
  return { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(maxOpaqueBytes) };
}

const DATA = { pages: [{ title: "Home" }, { title: "About" }], brand: { price: "10" } };

describe("ArtifactTree.fromJson + toJson", () => {
  it("round-trips a nested value when the whole tree is opaque", () => {
    const tree = ArtifactTree.fromJson(DATA, deps(1_000_000));
    expect(tree.toJson()).toEqual(DATA);
    expect(tree.size()).toBe(1); // entire JSON kept as one opaque leaf
    expect(tree.root().kind).toBe("leaf");
  });

  it("round-trips a nested value when decomposed", () => {
    const tree = ArtifactTree.fromJson(DATA, deps(5));
    expect(tree.toJson()).toEqual(DATA);
    expect(tree.size()).toBeGreaterThan(1); // it split
    expect(tree.root().kind).toBe("object");
  });

  it("exposes ordered children with their keys", () => {
    const tree = ArtifactTree.fromJson(DATA, deps(5));
    const rootChildren = tree.children(tree.rootIdValue());
    expect(rootChildren.map((c) => c.key)).toEqual(["pages", "brand"]);
  });

  it("preserves array element order via numeric keys", () => {
    const tree = ArtifactTree.fromJson(DATA, deps(5));
    const pages = tree.children(tree.rootIdValue()).find((c) => c.key === "pages")!;
    expect(tree.children(pages.id).map((c) => c.key)).toEqual([0, 1]);
  });

  it("stamps parentId, version 0 and clock time on built nodes", () => {
    const tree = ArtifactTree.fromJson(DATA, deps(5));
    const root = tree.root();
    expect(root.parentId).toBeNull();
    expect(root.meta.version).toBe(0);
    expect(root.meta.updatedAt).toBe(0);
    const child = tree.children(root.id)[0];
    expect(child.parentId).toBe(root.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/artifact-tree.test.ts`
Expected: FAIL — cannot resolve `../src/artifact-tree`.

- [ ] **Step 3: Write `src/artifact-tree.ts`**

```ts
import type { ArbNode, Json, NodeId } from "./types";
import type { IdGen } from "./ids";
import type { Clock } from "./clock";
import { type DecomposeDecision, kindOf } from "./decompose";

export interface TreeDeps {
  idGen: IdGen;
  clock: Clock;
  decision: DecomposeDecision;
}

export class ArtifactTree {
  private readonly nodes = new Map<NodeId, ArbNode>();
  private rootId!: NodeId;

  private constructor(private readonly deps: TreeDeps) {}

  static fromJson(json: Json, deps: TreeDeps): ArtifactTree {
    const tree = new ArtifactTree(deps);
    tree.rootId = tree.build(json, null, null);
    return tree;
  }

  private build(value: Json, parentId: NodeId | null, key: string | number | null): NodeId {
    const opaque = this.deps.decision.isOpaque(value);
    const kind = kindOf(value, opaque);
    const id = this.deps.idGen.next();
    const node: ArbNode = {
      id,
      parentId,
      key,
      kind,
      content: kind === "leaf" ? value : null,
      childIds: [],
      meta: { version: 0, updatedAt: this.deps.clock.now(), embedding: { state: "none" } },
    };
    this.nodes.set(id, node);

    if (kind === "object") {
      for (const [k, v] of Object.entries(value as Record<string, Json>)) {
        node.childIds.push(this.build(v, id, k));
      }
    } else if (kind === "array") {
      (value as Json[]).forEach((v, i) => {
        node.childIds.push(this.build(v, id, i));
      });
    }
    return id;
  }

  get(id: NodeId): ArbNode | undefined {
    return this.nodes.get(id);
  }

  root(): ArbNode {
    return this.nodes.get(this.rootId)!;
  }

  rootIdValue(): NodeId {
    return this.rootId;
  }

  children(id: NodeId): ArbNode[] {
    const n = this.nodes.get(id);
    if (!n) return [];
    return n.childIds.map((cid) => this.nodes.get(cid)!);
  }

  has(id: NodeId): boolean {
    return this.nodes.has(id);
  }

  size(): number {
    return this.nodes.size;
  }

  /** Reconstruct the JSON value rooted at `id` (defaults to the tree root). */
  toJson(id: NodeId = this.rootId): Json {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`Unknown node: ${id}`);
    if (n.kind === "leaf") return n.content;
    if (n.kind === "array") return n.childIds.map((cid) => this.toJson(cid));
    const obj: Record<string, Json> = {};
    for (const cid of n.childIds) {
      const c = this.nodes.get(cid)!;
      obj[String(c.key)] = this.toJson(cid);
    }
    return obj;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/artifact-tree.test.ts`
Expected: PASS — all tests passed.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/artifact-tree.ts test/artifact-tree.test.ts
git commit -m "feat: ArtifactTree build-from-JSON and reconstruct"
```

---

### Task 6: `Addressing` (byId / pathOf / byPath)

**Files:**
- Create: `src/addressing.ts`
- Test: `test/addressing.test.ts`

- [ ] **Step 1: Write the failing test `test/addressing.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";
import { sizeBasedDecision } from "../src/decompose";

function buildTree(): ArtifactTree {
  const deps: TreeDeps = {
    idGen: new SeqIdGen(),
    clock: new FixedClock(0),
    decision: sizeBasedDecision(5), // small -> fully decomposed
  };
  return ArtifactTree.fromJson({ pages: [{ title: "Home" }] }, deps);
}

describe("Addressing", () => {
  it("returns the empty pointer for the root", () => {
    const tree = buildTree();
    const addr = new Addressing(tree);
    expect(addr.pathOf(tree.rootIdValue())).toBe("");
  });

  it("computes a JSON Pointer path for a nested node", () => {
    const tree = buildTree();
    const addr = new Addressing(tree);
    const node = addr.byPath("/pages/0/title")!;
    expect(node).toBeDefined();
    expect(node.content).toBe("Home");
    expect(addr.pathOf(node.id)).toBe("/pages/0/title");
  });

  it("resolves byId", () => {
    const tree = buildTree();
    const addr = new Addressing(tree);
    const node = addr.byPath("/pages/0/title")!;
    expect(addr.byId(node.id)).toBe(node);
  });

  it("returns undefined for a path that does not exist", () => {
    const tree = buildTree();
    const addr = new Addressing(tree);
    expect(addr.byPath("/pages/9/title")).toBeUndefined();
  });

  it("round-trips path<->id for every node in the tree", () => {
    const tree = buildTree();
    const addr = new Addressing(tree);
    const visit = (id: string) => {
      expect(addr.byPath(addr.pathOf(id))!.id).toBe(id);
      for (const child of tree.children(id)) visit(child.id);
    };
    visit(tree.rootIdValue());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/addressing.test.ts`
Expected: FAIL — cannot resolve `../src/addressing`.

- [ ] **Step 3: Write `src/addressing.ts`**

```ts
import type { ArbNode, NodeId } from "./types";
import type { ArtifactTree } from "./artifact-tree";
import { buildPointer, parsePointer } from "./jsonpointer";

/**
 * Resolves nodes by stable id and by JSON Pointer path.
 * `path` is DERIVED from the current structure (not stored), so it stays
 * consistent automatically — id is identity, path is current location.
 */
export class Addressing {
  constructor(private readonly tree: ArtifactTree) {}

  byId(id: NodeId): ArbNode | undefined {
    return this.tree.get(id);
  }

  /** Compute the JSON Pointer for a node by walking parent links to the root. */
  pathOf(id: NodeId): string {
    const cur0 = this.tree.get(id);
    if (!cur0) throw new Error(`Unknown node: ${id}`);
    const segments: (string | number)[] = [];
    let cur: ArbNode | undefined = cur0;
    while (cur && cur.parentId !== null) {
      segments.unshift(cur.key as string | number);
      cur = this.tree.get(cur.parentId);
    }
    return buildPointer(segments);
  }

  /** Resolve a JSON Pointer to a node, or undefined if any segment is missing. */
  byPath(pointer: string): ArbNode | undefined {
    const segments = parsePointer(pointer);
    let cur: ArbNode | undefined = this.tree.root();
    for (const seg of segments) {
      if (!cur) return undefined;
      const child = this.tree.children(cur.id).find((c) => String(c.key) === seg);
      if (!child) return undefined;
      cur = child;
    }
    return cur;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/addressing.test.ts`
Expected: PASS — all tests passed.

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all test files pass; no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/addressing.ts test/addressing.test.ts
git commit -m "feat: Addressing (byId/pathOf/byPath) with derived paths"
```

---

## Milestone 1 — Definition of Done

- [ ] `npm test` — all suites pass.
- [ ] `npm run typecheck` — no errors.
- [ ] You can: `ArtifactTree.fromJson(json, deps)` → walk via `children`/`root` → address via `Addressing.byPath`/`byId`/`pathOf` → `toJson()` reconstructs the input.

---

## Roadmap: subsequent plans (each its own working, testable milestone)

Maps to spec §10 steps 2–9. Each becomes its own plan written when the prior milestone is done.

- **M2 — Mutations & reversible event-log** (§8, §10.2): `ops` (`set`/`insert`/`remove`/`move`), `Mutator` (validate→apply transaction), scope-check hook, append-only **reversible** log (`before`+`after`), `transaction(fn)`, typed error results (`NodeNotFound`/`ScopeViolation`/`StaleVersion`). Move re-parents and path stays consistent (already derived).
- **M3 — Schema-optional** (§5, §10.3): type registry, Zod-adapter validator, validation on patch, **decompose type-override** (`decompose: "opaque"|"children"` beats size).
- **M4 — Navigator + exact index** (§6, §7-exact, §10.4): `describe`/`get`/`find` (glob `pathPattern`), bounding/pagination/self-describing results, synchronous `tag`/`type` maps.
- **M5 — Semantic index** (§7, §10.5): `EmbeddingPort`/`VectorIndexPort` (mock-deterministic + in-memory brute-force cosine), `toEmbeddingText`, stale lifecycle + `textHash` dedupe, async reindexer, `search` with `best-effort`/`wait`/`reindex`.
- **M6 — Storage** (§10.6): in-memory + file-snapshot adapters (tree + vectors), snapshots as checkpoints, restore.
- **M7 — Replay / time-travel** (§8, §10.7): `getAt(ref, version)`, full-tree reconstruction from nearest checkpoint, `revert(ref, toVersion)`, `diff(vA, vB)`.
- **M8 — Toolset** (§6, §10.8): `makeToolset({owner, writeScope, readScope})`, LangChain `tool()` wrappers.
- **M9 — Scenario / e2e + example** (§9, §10.9): content-generator-shaped fixtures, multi-agent scoped flow asserting `ScopeViolation` and bounded payloads, runnable `examples/site-scenario.ts`.

---

## Self-Review (against the spec)

**Spec coverage (this plan):** §4 `ArtifactTree`/`Addressing`/`Clock`/`IdGen` → Tasks 2,5,6. §5 Node model → Task 2; identity-vs-path (derived path) → Task 6; size-based decomposition → Task 4. Remaining spec sections are explicitly deferred to M2–M9 in the Roadmap (no silent gaps).

**Placeholder scan:** No TBD/TODO; every code step contains full code; every run step has an exact command + expected result.

**Type consistency:** `ArbNode` fields (`id`/`parentId`/`key`/`kind`/`content`/`childIds`/`meta`) are used identically across Tasks 2,5,6. `TreeDeps` (`idGen`/`clock`/`decision`) is defined in Task 5 and consumed verbatim in Tasks 5,6. `ArtifactTree` public methods (`get`/`root`/`rootIdValue`/`children`/`has`/`size`/`toJson`) match between definition (Task 5) and use (Task 6). `DecomposeDecision.isOpaque` defined in Task 4, used in Task 5. JSON Pointer helpers (`buildPointer`/`parsePointer`) defined in Task 3, used in Task 6. Consistent.
