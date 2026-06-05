# Arbor — M3: Schema-Optional Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional per-node type system: a `TypeRegistry` whose types carry a validator and a decompose override, a Zod-compatible validator adapter, and the wiring so that typed mutations are validated and decomposed according to their type — all without making the core depend on Zod.

**Architecture:** M3 is mostly additive and leans on two seams already built. (1) `DecomposeDecision.isOpaque(value, type?)` already accepts an optional type — a `typeAwareDecision` wraps a base decision and consults the registry's per-type `decompose` override. (2) `Mutator` already calls `deps.validate?.({node, proposed, type, op})` — `makeRegistryValidator` turns a registry into that `Validator`. The only edits to existing files thread an optional `type` through `ArtifactTree.build`/`insertChild`/`replaceValue` (so a typed node records its type and decomposes by override) and through `Mutator.set`/`insert` (compute the effective type, validate with it, set it on the node). The Zod adapter uses structural typing (any object with `.parse()`), so Arbor ships **zero runtime dependencies**; Zod is only a devDependency used by tests.

**Tech Stack:** Node ≥20.6, TypeScript (ESM, strict), Vitest. Zod as a **devDependency** only (for the adapter/integration tests). Builds on M1+M2.

---

## Scope of THIS plan (Milestone 3)

Covers spec §5 (schema-optional: type registry, Zod-adapter validator, validation on patch, decompose type-override) and §10.3. Produces working, testable software: register named types (validator + decompose override), and have the `Mutator` validate typed mutations and decompose them per type.

**Out of scope here (later milestones):** navigator read tools / exact tag index (M4), semantic index + per-type embedding-text extraction (M5 — `TypeDef` intentionally does NOT carry `embedText` yet), storage (M6), replay (M7), toolset (M8), scenario (M9).

## Design decisions (locked for M3)

1. **A node's `type` is set explicitly at mutation time** via `MutateOpts.type`. `insert(..., {type})` types the new node; `set(ref, value, {type})` (re)types the target. `set` without `type` reuses the node's existing `type` (effective type = `opts.type ?? node.type`).
2. **Validation reuses the existing M2 `Validator` hook.** `makeRegistryValidator(registry)` produces the `Validator`; `Mutator` is unchanged in shape — it just passes the effective type. A throwing validator rejects the mutation BEFORE any tree/log change (M2 guarantee).
3. **Decompose override reuses the M1 `isOpaque(value, type?)` seam.** `typeAwareDecision(base, registry)` returns `true`/`false` when the type declares `decompose: "opaque"|"children"`, else falls back to `base`. The tree threads `type` into `isOpaque` via `build`/`replaceValue`.
4. **No Zod runtime dependency.** `zodValidate(schema)` accepts any `{ parse(v): unknown }` (Zod's shape) and wraps a thrown parse error in `ValidationError`. Zod is a devDependency for tests only.
5. **All edits to existing files are additive** (optional params with defaults; new struct fields). M1+M2 call sites and tests are unaffected.

## File Structure (Milestone 3)

- Modify: `src/errors.ts` — add `ValidationError` (code `"VALIDATION_ERROR"`, fields `type?`, `details`).
- Create: `src/type-registry.ts` — `TypeDef` (`validate?`, `decompose?`), `TypeRegistry` (`register`/`get`/`has`).
- Create: `src/registry-validator.ts` — `makeRegistryValidator(registry): Validator`.
- Create: `src/type-aware-decision.ts` — `typeAwareDecision(base, registry): DecomposeDecision`.
- Create: `src/zod-adapter.ts` — `ParseSchema`, `zodValidate(schema, typeName?)`.
- Modify: `src/artifact-tree.ts` — thread optional `type` through `build`, `insertChild`, `replaceValue` (set `node.type`, pass to `isOpaque`). No other methods change.
- Modify: `src/mutator.ts` — `MutateOpts.type?`; `set`/`insert` compute effective type, validate with it, pass it to the tree primitive.
- Modify: `package.json` — add `zod` to devDependencies.
- Test: `test/type-registry.test.ts`, `test/registry-validator.test.ts`, `test/type-aware-decision.test.ts`, `test/zod-adapter.test.ts`, `test/artifact-tree-type.test.ts`, `test/mutator-type.test.ts`, `test/m3-schema.test.ts`.

---

### Task 1: `ValidationError` + `TypeRegistry`

**Files:**
- Modify: `src/errors.ts` (ADD one class; do not change existing)
- Create: `src/type-registry.ts`
- Test: `test/type-registry.test.ts`

- [ ] **Step 1: Write the failing test `test/type-registry.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { TypeRegistry } from "../src/type-registry";
import { ValidationError, ArborError } from "../src/errors";

describe("ValidationError", () => {
  it("carries code, type, and details and is an ArborError", () => {
    const e = new ValidationError("PageContent", "title is required");
    expect(e).toBeInstanceOf(ArborError);
    expect(e.code).toBe("VALIDATION_ERROR");
    expect(e.type).toBe("PageContent");
    expect(e.details).toBe("title is required");
  });

  it("allows an undefined type", () => {
    const e = new ValidationError(undefined, "bad");
    expect(e.type).toBeUndefined();
    expect(e.message).toContain("bad");
  });
});

describe("TypeRegistry", () => {
  it("registers and retrieves a type definition", () => {
    const r = new TypeRegistry();
    const def = { decompose: "opaque" as const };
    r.register("PageContent", def);
    expect(r.get("PageContent")).toBe(def);
    expect(r.has("PageContent")).toBe(true);
  });

  it("returns undefined and false for an unknown type", () => {
    const r = new TypeRegistry();
    expect(r.get("Nope")).toBeUndefined();
    expect(r.has("Nope")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/type-registry.test.ts`
Expected: FAIL — cannot resolve `../src/type-registry`; `ValidationError` not exported.

- [ ] **Step 3: Add `ValidationError` to `src/errors.ts`**

Append this class to the END of `src/errors.ts` (after `InvalidOpError`; do not modify existing classes):

```ts
export class ValidationError extends ArborError {
  constructor(
    public readonly type: string | undefined,
    public readonly details: string,
  ) {
    super("VALIDATION_ERROR", `Validation failed${type ? ` for type ${type}` : ""}: ${details}`);
  }
}
```

- [ ] **Step 4: Write `src/type-registry.ts`**

```ts
import type { Json } from "./types";

/** Definition of a registered node type. */
export interface TypeDef {
  /** Validate a value about to be stored at a node of this type. Throw to reject. */
  validate?: (value: Json) => void;
  /** Override the size-based decomposition for nodes of this type. */
  decompose?: "opaque" | "children";
}

/** A registry of named node types (validator + decompose override). */
export class TypeRegistry {
  private readonly types = new Map<string, TypeDef>();

  register(name: string, def: TypeDef): void {
    this.types.set(name, def);
  }

  get(name: string): TypeDef | undefined {
    return this.types.get(name);
  }

  has(name: string): boolean {
    return this.types.has(name);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/type-registry.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/errors.ts src/type-registry.ts test/type-registry.test.ts
git commit -m "feat: ValidationError and TypeRegistry"
```

---

### Task 2: `makeRegistryValidator`

**Files:**
- Create: `src/registry-validator.ts`
- Test: `test/registry-validator.test.ts`

- [ ] **Step 1: Write the failing test `test/registry-validator.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { TypeRegistry } from "../src/type-registry";
import { makeRegistryValidator } from "../src/registry-validator";

describe("makeRegistryValidator", () => {
  it("runs the registered validate() for the given type", () => {
    const r = new TypeRegistry();
    r.register("Num", { validate: (v) => { if (typeof v !== "number") throw new Error("not a number"); } });
    const validate = makeRegistryValidator(r);
    expect(() => validate({ node: null, proposed: "x", type: "Num", op: "set" })).toThrow("not a number");
    expect(() => validate({ node: null, proposed: 5, type: "Num", op: "set" })).not.toThrow();
  });

  it("is a no-op when type is undefined", () => {
    const r = new TypeRegistry();
    const validate = makeRegistryValidator(r);
    expect(() => validate({ node: null, proposed: "anything", type: undefined, op: "insert" })).not.toThrow();
  });

  it("is a no-op when the type is unregistered or has no validate", () => {
    const r = new TypeRegistry();
    r.register("NoValidate", { decompose: "opaque" });
    const validate = makeRegistryValidator(r);
    expect(() => validate({ node: null, proposed: "x", type: "Unknown", op: "set" })).not.toThrow();
    expect(() => validate({ node: null, proposed: "x", type: "NoValidate", op: "set" })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/registry-validator.test.ts`
Expected: FAIL — cannot resolve `../src/registry-validator`.

- [ ] **Step 3: Write `src/registry-validator.ts`**

```ts
import type { Validator } from "./mutator";
import type { TypeRegistry } from "./type-registry";

/** Build a Mutator `Validator` that runs the registered `validate()` for the node's type. */
export function makeRegistryValidator(registry: TypeRegistry): Validator {
  return ({ proposed, type }) => {
    if (type === undefined) return;
    registry.get(type)?.validate?.(proposed);
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/registry-validator.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/registry-validator.ts test/registry-validator.test.ts
git commit -m "feat: makeRegistryValidator wires a TypeRegistry into the Mutator validate hook"
```

---

### Task 3: `typeAwareDecision`

**Files:**
- Create: `src/type-aware-decision.ts`
- Test: `test/type-aware-decision.test.ts`

- [ ] **Step 1: Write the failing test `test/type-aware-decision.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { TypeRegistry } from "../src/type-registry";
import { typeAwareDecision } from "../src/type-aware-decision";
import { sizeBasedDecision } from "../src/decompose";

describe("typeAwareDecision", () => {
  const registry = new TypeRegistry();
  registry.register("Opaque", { decompose: "opaque" });
  registry.register("Children", { decompose: "children" });
  const decision = typeAwareDecision(sizeBasedDecision(1_000_000), registry);

  it("forces opaque for a type with decompose 'opaque' (even when size would split)", () => {
    // a big object would normally split under a tiny threshold; here we prove the type wins
    const tiny = typeAwareDecision(sizeBasedDecision(2), registry);
    expect(tiny.isOpaque({ a: 1, b: 2, c: 3 }, "Opaque")).toBe(true);
  });

  it("forces children for a type with decompose 'children' (even when size would keep opaque)", () => {
    // a small object would normally stay opaque under a huge threshold; the type splits it
    expect(decision.isOpaque({ a: 1 }, "Children")).toBe(false);
  });

  it("falls back to the base decision when the type has no override", () => {
    registry.register("Plain", {});
    expect(decision.isOpaque({ a: 1 }, "Plain")).toBe(true); // base: 7 bytes <= 1e6 -> opaque
    expect(decision.isOpaque({ a: 1 })).toBe(true); // no type -> base
  });

  it("falls back to the base decision for an unregistered type", () => {
    expect(decision.isOpaque({ a: 1 }, "Unknown")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/type-aware-decision.test.ts`
Expected: FAIL — cannot resolve `../src/type-aware-decision`.

- [ ] **Step 3: Write `src/type-aware-decision.ts`**

```ts
import type { Json } from "./types";
import type { DecomposeDecision } from "./decompose";
import type { TypeRegistry } from "./type-registry";

/** Wrap a base decision so a node's registered type can override the size heuristic. */
export function typeAwareDecision(base: DecomposeDecision, registry: TypeRegistry): DecomposeDecision {
  return {
    isOpaque(value: Json, type?: string): boolean {
      if (type !== undefined) {
        const override = registry.get(type)?.decompose;
        if (override === "opaque") return true;
        if (override === "children") return false;
      }
      return base.isOpaque(value, type);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/type-aware-decision.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/type-aware-decision.ts test/type-aware-decision.test.ts
git commit -m "feat: typeAwareDecision applies per-type decompose override"
```

---

### Task 4: Zod adapter (`zodValidate`)

**Files:**
- Modify: `package.json` (add `zod` to devDependencies)
- Create: `src/zod-adapter.ts`
- Test: `test/zod-adapter.test.ts`

- [ ] **Step 1: Add `zod` as a devDependency**

In `package.json`, add `"zod": "^3.24.0"` to the `devDependencies` object (keep the existing entries). The resulting `devDependencies` must contain at least:

```json
  "devDependencies": {
    "@types/node": "^20.14.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8",
    "zod": "^3.24.0"
  }
```

Then run: `npm install`
Expected: `zod` added to `node_modules`, exit 0.

- [ ] **Step 2: Write the failing test `test/zod-adapter.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { zodValidate } from "../src/zod-adapter";
import { ValidationError } from "../src/errors";

const schema = z.object({ title: z.string() });

describe("zodValidate", () => {
  it("passes a value that matches the schema", () => {
    const validate = zodValidate(schema, "T");
    expect(() => validate({ title: "ok" })).not.toThrow();
  });

  it("throws ValidationError for a value that fails the schema", () => {
    const validate = zodValidate(schema, "T");
    expect(() => validate({ title: 5 })).toThrow(ValidationError);
  });

  it("includes the type name on the thrown error", () => {
    const validate = zodValidate(schema, "MyType");
    let caught: unknown;
    try {
      validate({});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).type).toBe("MyType");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/zod-adapter.test.ts`
Expected: FAIL — cannot resolve `../src/zod-adapter`.

- [ ] **Step 4: Write `src/zod-adapter.ts`**

```ts
import type { Json } from "./types";
import { ValidationError } from "./errors";

/** Structural shape of a parser (e.g. a Zod schema). Avoids hard-coupling Arbor to a Zod version. */
export interface ParseSchema {
  parse(value: unknown): unknown;
}

/**
 * Build a `TypeDef.validate` function from any Zod-compatible schema (anything with `.parse()`).
 * Throws `ValidationError` (wrapping the parser's error message) when the value is invalid.
 */
export function zodValidate(schema: ParseSchema, typeName?: string): (value: Json) => void {
  return (value: Json) => {
    try {
      schema.parse(value);
    } catch (err) {
      const details = err instanceof Error ? err.message : String(err);
      throw new ValidationError(typeName, details);
    }
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/zod-adapter.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add package.json package-lock.json src/zod-adapter.ts test/zod-adapter.test.ts
git commit -m "feat: zodValidate adapter (structural, zero runtime dep)"
```

---

### Task 5: Thread `type` through `ArtifactTree`

**Files:**
- Modify: `src/artifact-tree.ts` (replace `build`, `replaceValue`, `insertChild` with the versions below; no other method changes)
- Test: `test/artifact-tree-type.test.ts`

- [ ] **Step 1: Write the failing test `test/artifact-tree-type.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { type DecomposeDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

// A decision that honors a type override, else treats only scalars as opaque.
const decision: DecomposeDecision = {
  isOpaque(value, type) {
    if (type === "opaque") return true;
    if (type === "children") return false;
    return value === null || typeof value !== "object";
  },
};

function makeTree(json: unknown): ArtifactTree {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision };
  return ArtifactTree.fromJson(json as never, deps);
}

describe("ArtifactTree type threading", () => {
  it("records node.type on an inserted child", () => {
    const tree = makeTree({});
    const id = tree.insertChild(tree.rootIdValue(), "k", { a: 1 }, "children");
    expect(tree.get(id)!.type).toBe("children");
  });

  it("type 'children' forces a value to decompose", () => {
    const tree = makeTree({});
    const id = tree.insertChild(tree.rootIdValue(), "k", { a: 1 }, "children");
    expect(tree.get(id)!.kind).toBe("object");
  });

  it("type 'opaque' forces a value to stay a leaf", () => {
    const tree = makeTree({});
    const id = tree.insertChild(tree.rootIdValue(), "k", { a: 1, b: 2 }, "opaque");
    expect(tree.get(id)!.kind).toBe("leaf");
    expect(tree.get(id)!.type).toBe("opaque");
  });

  it("replaceValue applies the type and its override in place", () => {
    const tree = makeTree({ x: "v" });
    const xId = tree.children(tree.rootIdValue())[0].id;
    tree.replaceValue(xId, { a: 1, b: 2 }, "opaque");
    expect(tree.get(xId)!.id).toBe(xId);
    expect(tree.get(xId)!.type).toBe("opaque");
    expect(tree.get(xId)!.kind).toBe("leaf");
    expect(tree.toJson()).toEqual({ x: { a: 1, b: 2 } });
  });

  it("untyped children built underneath a typed node are not given a type", () => {
    const tree = makeTree({});
    const id = tree.insertChild(tree.rootIdValue(), "k", { a: 1 }, "children");
    const childA = tree.children(id)[0];
    expect(childA.type).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/artifact-tree-type.test.ts`
Expected: FAIL — `insertChild` does not accept a 4th argument that sets `type` (the type assertions fail / `type` is undefined).

- [ ] **Step 3: Modify `src/artifact-tree.ts`**

Replace the existing `build` method with this version (adds the `type?` param, passes it to `isOpaque`, and stamps `node.type`):

```ts
  private build(value: Json, parentId: NodeId | null, key: string | number | null, type?: string): NodeId {
    const opaque = this.deps.decision.isOpaque(value, type);
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
    if (type !== undefined) node.type = type;
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
```

Replace the existing `replaceValue` method with this version (adds `type?`, passes it to `isOpaque`, stamps `node.type`):

```ts
  /** Replace the subtree value at `id` in place, keeping the node's id/key/parentId. */
  replaceValue(id: NodeId, value: Json, type?: string): void {
    const node = this.nodes.get(id);
    if (!node) throw new InvalidOpError(`Unknown node: ${id}`);
    this.deleteDescendants(id);
    const opaque = this.deps.decision.isOpaque(value, type);
    const kind = kindOf(value, opaque);
    node.kind = kind;
    node.content = kind === "leaf" ? value : null;
    node.childIds = [];
    if (type !== undefined) node.type = type;
    if (kind === "object") {
      for (const [k, v] of Object.entries(value as Record<string, Json>)) {
        node.childIds.push(this.build(v, id, k));
      }
    } else if (kind === "array") {
      (value as Json[]).forEach((v, i) => {
        node.childIds.push(this.build(v, id, i));
      });
    }
  }
```

Replace the existing `insertChild` method with this version (adds `type?`, passes it to `build` in both branches):

```ts
  /** Insert a decomposed `value` as a child of `parentId`. For objects `keyOrIndex` is the string key; for arrays it is the insert index. Returns the new child's id. */
  insertChild(parentId: NodeId, keyOrIndex: string | number, value: Json, type?: string): NodeId {
    const parent = this.nodes.get(parentId);
    if (!parent) throw new InvalidOpError(`Unknown node: ${parentId}`);
    if (parent.kind === "object") {
      if (typeof keyOrIndex !== "string") {
        throw new InvalidOpError("object insert requires a string key");
      }
      if (parent.childIds.some((cid) => this.nodes.get(cid)!.key === keyOrIndex)) {
        throw new InvalidOpError(`key already exists: ${keyOrIndex}`);
      }
      const cid = this.build(value, parentId, keyOrIndex, type);
      parent.childIds.push(cid);
      return cid;
    }
    if (parent.kind === "array") {
      if (typeof keyOrIndex !== "number") {
        throw new InvalidOpError("array insert requires a numeric index");
      }
      const at = Math.max(0, Math.min(keyOrIndex, parent.childIds.length));
      const cid = this.build(value, parentId, at, type);
      parent.childIds.splice(at, 0, cid);
      this.renumberArray(parentId);
      return cid;
    }
    throw new InvalidOpError("cannot insert into a leaf node");
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/artifact-tree-type.test.ts`
Expected: PASS (5 tests). Then `npx vitest run` — confirm NO regressions in M1/M2 tree tests (existing 3-arg `build`/`insertChild`/`replaceValue` calls still compile and behave identically, since `type` defaults to undefined).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/artifact-tree.ts test/artifact-tree-type.test.ts
git commit -m "feat: thread optional type through ArtifactTree build/insert/replace"
```

---

### Task 6: Mutator type integration

**Files:**
- Modify: `src/mutator.ts` (add `type?` to `MutateOpts`; replace `set` and `insert`; no other method changes)
- Test: `test/mutator-type.test.ts`

- [ ] **Step 1: Write the failing test `test/mutator-type.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { type DecomposeDecision } from "../src/decompose";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator, type Validator } from "../src/mutator";
import { ValidationError } from "../src/errors";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

const decision: DecomposeDecision = {
  isOpaque(value, type) {
    if (type === "opaque") return true;
    return value === null || typeof value !== "object";
  },
};

function setup(json: unknown, validate?: Validator) {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision };
  const tree = ArtifactTree.fromJson(json as never, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock, validate });
  return { tree, addressing, log, mutator };
}

describe("Mutator type integration", () => {
  it("insert with a type sets node.type and passes the type to the validator", () => {
    const seen: Array<{ type?: string; op: string }> = [];
    const validate: Validator = ({ type, op }) => { seen.push({ type, op }); };
    const { tree, mutator } = setup({ a: 1 }, validate);
    const id = mutator.insert({ path: "" }, "b", 2, { type: "MyType" });
    expect(tree.get(id)!.type).toBe("MyType");
    expect(seen).toEqual([{ type: "MyType", op: "insert" }]);
  });

  it("set with opts.type retypes the node and validates with that type", () => {
    const seen: Array<string | undefined> = [];
    const validate: Validator = ({ type }) => { seen.push(type); };
    const { addressing, mutator } = setup({ a: 1 }, validate);
    mutator.set({ path: "/a" }, 2, { type: "T" });
    expect(addressing.byPath("/a")!.type).toBe("T");
    expect(seen).toEqual(["T"]);
  });

  it("set without opts.type reuses the node's existing type", () => {
    const seen: Array<string | undefined> = [];
    const validate: Validator = ({ type }) => { seen.push(type); };
    const { mutator } = setup({ a: 1 }, validate);
    mutator.set({ path: "/a" }, 2, { type: "T" }); // node.type becomes "T"
    mutator.set({ path: "/a" }, 3); // effective type = existing "T"
    expect(seen).toEqual(["T", "T"]);
  });

  it("rejects when the validator throws, leaving tree and log untouched", () => {
    const validate: Validator = ({ proposed }) => {
      if (proposed === 99) throw new ValidationError("T", "nope");
    };
    const { tree, log, mutator } = setup({ a: 1 }, validate);
    expect(() => mutator.set({ path: "/a" }, 99, { type: "T" })).toThrow(ValidationError);
    expect(tree.toJson()).toEqual({ a: 1 });
    expect(log.length()).toBe(0);
  });

  it("applies the type's decompose override on insert", () => {
    const { tree, mutator } = setup({ a: 1 });
    const id = mutator.insert({ path: "" }, "blob", { x: 1, y: 2 }, { type: "opaque" });
    expect(tree.get(id)!.kind).toBe("leaf"); // override forces opaque
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mutator-type.test.ts`
Expected: FAIL — `MutateOpts` has no `type`; `set`/`insert` don't set `node.type` or pass the type through.

- [ ] **Step 3: Modify `src/mutator.ts`**

Add a `type` field to `MutateOpts`. Replace the existing `MutateOpts` interface with:

```ts
export interface MutateOpts {
  owner?: string;
  /** JSON Pointer prefix; the target must be at or under it. */
  writeScope?: string;
  /** Optimistic concurrency: reject unless the target's current version equals this. */
  ifVersion?: number;
  /** Register/override the node's type (drives validation and the decompose override). */
  type?: string;
}
```

Replace the existing `set` method with:

```ts
  set(ref: Ref, value: Json, opts: MutateOpts = {}): void {
    const node = this.resolve(ref);
    this.checkScope(node, opts.writeScope);
    this.checkVersion(node, opts.ifVersion);
    const type = opts.type ?? node.type;
    this.deps.validate?.({ node, proposed: value, type, op: "set" });
    const before = this.tree.toJson(node.id);
    this.tree.replaceValue(node.id, value, type);
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

Replace the existing `insert` method with:

```ts
  insert(parentRef: Ref, keyOrIndex: string | number, value: Json, opts: MutateOpts = {}): NodeId {
    const parent = this.resolve(parentRef);
    this.checkScope(parent, opts.writeScope);
    this.checkVersion(parent, opts.ifVersion);
    const type = opts.type;
    this.deps.validate?.({ node: null, proposed: value, type, op: "insert" });
    const newId = this.tree.insertChild(parent.id, keyOrIndex, value, type);
    this.bump(parent, opts.owner);
    const child = this.tree.get(newId)!;
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

Run: `npx vitest run test/mutator-type.test.ts`
Expected: PASS (5 tests). Then `npx vitest run` — confirm NO regressions (M2 mutator tests still pass: they call `set`/`insert` without `opts.type`, so `type` is `undefined` and behavior is identical).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/mutator.ts test/mutator-type.test.ts
git commit -m "feat: Mutator threads effective type into validation and decomposition"
```

---

### Task 7: Capstone — Zod + registry + decompose override end-to-end

**Files:**
- Test: `test/m3-schema.test.ts` (test-only; exercises all M3 pieces together with a real Zod schema)

- [ ] **Step 1: Write the failing test `test/m3-schema.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ArtifactTree } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { TypeRegistry } from "../src/type-registry";
import { makeRegistryValidator } from "../src/registry-validator";
import { typeAwareDecision } from "../src/type-aware-decision";
import { zodValidate } from "../src/zod-adapter";
import { ValidationError } from "../src/errors";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

const PageContent = z.object({ title: z.string(), body: z.string() });

function setup() {
  const registry = new TypeRegistry();
  registry.register("PageContent", { validate: zodValidate(PageContent, "PageContent"), decompose: "opaque" });
  const clock = new FixedClock(0);
  // small base threshold so the untyped scaffold decomposes; the typed node is forced opaque by its type
  const decision = typeAwareDecision(sizeBasedDecision(3), registry);
  const tree = ArtifactTree.fromJson({ a: 1 }, { idGen: new SeqIdGen(), clock, decision });
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock, validate: makeRegistryValidator(registry) });
  return { tree, log, mutator };
}

describe("M3 schema-optional integration", () => {
  it("accepts a valid typed insert, stores it opaque, types it, and logs it", () => {
    const { tree, log, mutator } = setup();
    const id = mutator.insert({ path: "" }, "home", { title: "Home", body: "<h1>Hi</h1>" }, { type: "PageContent" });
    expect(tree.get(id)!.type).toBe("PageContent");
    expect(tree.get(id)!.kind).toBe("leaf"); // decompose override -> opaque
    expect(tree.toJson()).toEqual({ a: 1, home: { title: "Home", body: "<h1>Hi</h1>" } });
    expect(log.length()).toBe(1);
  });

  it("rejects an invalid typed insert with ValidationError and changes nothing", () => {
    const { tree, log, mutator } = setup();
    expect(() =>
      mutator.insert({ path: "" }, "bad", { title: "missing body" }, { type: "PageContent" }),
    ).toThrow(ValidationError);
    expect(tree.toJson()).toEqual({ a: 1 });
    expect(log.length()).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `npx vitest run test/m3-schema.test.ts`
Expected: PASS — every piece it relies on was built in Tasks 1–6. (If it fails, the failure pinpoints which wiring is wrong; fix the corresponding source from the earlier task rather than this test.)

- [ ] **Step 3: Run the full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all suites pass; no type errors.

- [ ] **Step 4: Commit**

```bash
git add test/m3-schema.test.ts
git commit -m "test: M3 schema-optional end-to-end (Zod + registry + decompose override)"
```

---

## Milestone 3 — Definition of Done

- [ ] `npm test` — all suites pass (M1 + M2 + M3).
- [ ] `npm run typecheck` — no errors.
- [ ] You can: register named types (validator + decompose override); a typed `insert`/`set` validates the value (rejecting with `ValidationError` before any tree/log change), stamps `node.type`, and decomposes by the type's override; a Zod schema becomes a validator via `zodValidate`; untyped mutations behave exactly as in M2.

---

## Roadmap: subsequent plans

- **M4 — Navigator + exact index** (`describe`/`get`/`find`, tag/type maps). The `type` now recorded on nodes feeds the `type` exact-index.
- **M5 — Semantic index** (per-node embeddings; `TypeDef` gains `embedText`).
- **M6 — Storage**, **M7 — Replay**, **M8 — Toolset**, **M9 — Scenario**. (See the M1 plan roadmap.)

---

## Self-Review (against the spec)

**Spec coverage (this plan):** §5 type registry → Task 1; validation on patch → Tasks 2 + 6 (validator runs before any mutation, reuses the M2 guard ordering); Zod-adapter validator → Task 4; decompose type-override → Tasks 3 + 5; node carries `type` → Task 5 (`build`/`replaceValue` stamp it) + Task 6 (Mutator sets effective type). End-to-end proof → Task 7. Out-of-scope items (embed text, navigator, storage, replay, toolset) explicitly deferred in Scope.

**Placeholder scan:** No TBD/TODO; every code step has full code; every run step has an exact command + expected result. Task 7 step 2 is explicitly a "should already pass" capstone with rationale (not a placeholder).

**Type consistency:** `TypeDef` (`validate?: (value: Json) => void`, `decompose?: "opaque"|"children"`) defined in Task 1, consumed by `makeRegistryValidator` (Task 2), `typeAwareDecision` (Task 3), and the Zod adapter output (Task 4) / capstone (Task 7). `Validator` type (from M2 `mutator.ts`, signature `({node, proposed, type?, op}) => void`) is the return type of `makeRegistryValidator` (Task 2) and the param type in Tasks 6–7 — matches the existing M2 definition. `ValidationError(type?, details)` defined in Task 1, thrown by `zodValidate` (Task 4), asserted in Tasks 6–7. `ArtifactTree.build`/`insertChild`/`replaceValue` gain a trailing `type?: string` (Task 5) consumed by `Mutator.set`/`insert` (Task 6) — signatures match. `MutateOpts.type?` (Task 6) is the single entry point for a caller-supplied type. `typeAwareDecision`/`makeRegistryValidator` names are used identically in Tasks 3/2 and the capstone (Task 7).
