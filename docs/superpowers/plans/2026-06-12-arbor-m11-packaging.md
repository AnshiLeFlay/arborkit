# Arbor — M11: Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Arbor an installable npm package — barrel + tsup build to `dist/` (ESM + `.d.ts`) + `exports` map — proven by installing the packed tarball into a plain Node ESM project (no Bundler resolution, no tsx) and running it.

**Architecture:** Arbor's source uses extensionless imports under `moduleResolution: "Bundler"`, which plain Node ESM cannot resolve at runtime — so consumption today is only possible via tsconfig path aliases into `src/`. M11 adds a **build**: tsup bundles every public module as its own ESM entry (esbuild resolves the extensionless imports; code-splitting dedupes shared chunks; `.d.ts` emitted per entry), and `package.json` gains a root `"."` export (the new barrel) plus a `"./*"` wildcard subpath export so the existing per-module import style (`arbor/toolset`) works against `dist/`. The capstone proof is a pack-and-run test: `npm pack` → install the tarball into a temp fixture (`"type":"module"`, no TS config at all) → a Node smoke script exercises the quickstart flow through both the barrel and a subpath import. Existing tsconfig-paths consumers (content-generator-arbor) are untouched: `src/` stays in the repo; only the npm tarball is restricted to `dist/`.

**Tech Stack:** Node ≥20.6, TypeScript (ESM, strict), Vitest, **tsup** (new devDependency — esbuild-based build, emits ESM + dts). Zero runtime dependencies preserved.

---

## Scope of THIS plan (Milestone 11)

The packaging blocker from the post-v1 review: no `exports`/`main`/`types`/build → Arbor is "a folder you path-alias into". Produces: `npm run build` → `dist/`, `npm pack` → a tarball that installs and runs in plain Node ESM.

**Out of scope:** actually publishing to the public registry — `"private": true` is KEPT (the name `arbor` is taken on npm; publishing later = flip `private` + pick a scoped name, e.g. `@<scope>/arbor` — a one-line change once the name is decided). Also out: M12 growth work (log compaction, delta persist), CJS dual-format (Arbor is ESM-only by design).

## Design decisions (locked for M11)

1. **tsup, multi-entry, ESM-only.** `entry: ["src/*.ts"]` — all 25 modules + the new barrel each become their own `dist/<name>.js` + `.d.ts`; `splitting: true` extracts shared code into chunks (no duplication); `platform: "node"`, `target: "node20"`. Node builtins (`node:fs/promises` in file-storage) stay external automatically.
2. **Exports map = root barrel + wildcard subpaths.** `"."` → `dist/index.{js,d.ts}`; `"./*"` → `dist/*.{js,d.ts}`. The wildcard preserves the established import style (`arbor/artifact-tree`, `arbor/toolset`, …) with zero per-module maintenance. (It also exposes chunk files — harmless.)
3. **Barrel = `export *` from every module.** All 25 modules are public API (the downstream imports 20+ of them). If `tsc` reports an ambiguous re-export collision between two modules, resolve it with explicit named re-exports for the colliding symbols and note it — do NOT silently drop a symbol.
4. **`private: true` stays; `version: "1.0.0"`.** `npm pack` works for private packages; `private` only blocks accidental `npm publish`. v1 core is complete + hardened (M10) → 1.0.0.
5. **`files: ["dist"]`** — the tarball ships built output only; `src/` remains in git for the tsconfig-paths consumers and for development. `dist/` is already gitignored.
6. **The capstone is the REAL proof:** packed tarball + plain-Node fixture (no TypeScript, no bundler, no aliases) importing both `"arbor"` and `"arbor/replay"`. If that smoke runs, the packaging works by definition.

## File structure (Milestone 11)

- Create: `src/index.ts` — the barrel (public API surface).
- Create: `tsup.config.ts`.
- Modify: `package.json` — version, `sideEffects`, `main`/`module`/`types`, `exports`, `files`, `build`/`prepack` scripts, tsup devDep.
- Modify: `README.md` — "Install as a package" section + Status update.
- Test: `test/m11-barrel.test.ts`, `test/m11-packaging.test.ts` (pack-and-run capstone).

---

### Task 1: The barrel — `src/index.ts`

**Files:**
- Create: `src/index.ts`
- Test: `test/m11-barrel.test.ts`

- [ ] **Step 1: Write the failing test `test/m11-barrel.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import * as arbor from "../src/index";

describe("M11: barrel exports the public surface", () => {
  it("exposes the core classes and factories", () => {
    expect(typeof arbor.ArtifactTree).toBe("function");
    expect(typeof arbor.Addressing).toBe("function");
    expect(typeof arbor.EventLog).toBe("function");
    expect(typeof arbor.Mutator).toBe("function");
    expect(typeof arbor.Navigator).toBe("function");
    expect(typeof arbor.SemanticIndex).toBe("function");
    expect(typeof arbor.Replay).toBe("function");
    expect(typeof arbor.TypeRegistry).toBe("function");
    expect(typeof arbor.MemoryVectorIndex).toBe("function");
    expect(typeof arbor.MockEmbeddingPort).toBe("function");
    expect(typeof arbor.MemoryStorage).toBe("function");
    expect(typeof arbor.FileStorage).toBe("function");
  });

  it("exposes the function API", () => {
    expect(typeof arbor.makeToolset).toBe("function");
    expect(typeof arbor.serializeArtifact).toBe("function");
    expect(typeof arbor.restoreArtifact).toBe("function");
    expect(typeof arbor.zodValidate).toBe("function");
    expect(typeof arbor.makeRegistryValidator).toBe("function");
    expect(typeof arbor.typeAwareDecision).toBe("function");
    expect(typeof arbor.sizeBasedDecision).toBe("function");
    expect(typeof arbor.toEmbeddingText).toBe("function");
    expect(typeof arbor.matchGlob).toBe("function");
    expect(typeof arbor.getAtPath).toBe("function");
    expect(typeof arbor.buildPointer).toBe("function");
    expect(typeof arbor.SeqIdGen).toBe("function");
    expect(typeof arbor.SystemClock).toBe("function");
    expect(typeof arbor.ArborError).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/m11-barrel.test.ts`
Expected: FAIL — cannot resolve `../src/index`.

- [ ] **Step 3: Write `src/index.ts`**

```ts
// Arbor public API — one barrel over every module. Consumers may import from
// here ("arbor") or from per-module subpaths ("arbor/toolset", ...).
export * from "./types";
export * from "./ids";
export * from "./clock";
export * from "./jsonpointer";
export * from "./decompose";
export * from "./artifact-tree";
export * from "./addressing";
export * from "./errors";
export * from "./event-log";
export * from "./mutator";
export * from "./type-registry";
export * from "./registry-validator";
export * from "./type-aware-decision";
export * from "./zod-adapter";
export * from "./path-glob";
export * from "./navigator";
export * from "./embedding-port";
export * from "./embedding-text";
export * from "./semantic-index";
export * from "./vector-index-port";
export * from "./storage";
export * from "./file-storage";
export * from "./json-edit";
export * from "./replay";
export * from "./toolset";
```

If `npm run typecheck` flags an ambiguous re-export (two modules exporting the same name), keep `export *` for everything else and add explicit named re-exports for the colliding symbols (e.g. `export { Foo as TreeFoo } from "./artifact-tree";`) — report which names collided.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/m11-barrel.test.ts`
Expected: PASS (2 tests). Then `npx vitest run` — no regressions (244 prior + 2).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (clean), then:

```bash
git add src/index.ts test/m11-barrel.test.ts
git commit -m "feat: public-API barrel (src/index.ts)"
```

---

### Task 2: Build setup — tsup + package.json

**Files:**
- Create: `tsup.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Install tsup**

Run: `npm install -D tsup`
Expected: added to `devDependencies` (esbuild-based; no runtime deps added).

- [ ] **Step 2: Write `tsup.config.ts`**

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  // Every public module is its own entry (incl. the barrel), so the "./*"
  // subpath exports map cleanly onto dist/<module>.js.
  entry: ["src/*.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  dts: true,
  splitting: true, // shared code goes into chunks instead of being duplicated per entry
  sourcemap: true,
  clean: true,
});
```

- [ ] **Step 3: Update `package.json`**

The file becomes (preserving the existing devDependencies + adding tsup; note every changed/added field):

```json
{
  "name": "arbor",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "engines": { "node": ">=20.6" },
  "sideEffects": false,
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./*": { "types": "./dist/*.d.ts", "import": "./dist/*.js" }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "prepack": "npm run build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "example": "tsx examples/content-site.ts"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "tsup": "^8.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8",
    "zod": "^3.24.0"
  }
}
```

(`private: true` stays — `npm pack` works; only `publish` is blocked. Publishing later = flip it + a scoped name, since `arbor` is taken on the public registry.)

- [ ] **Step 4: Build and inspect**

Run: `npm run build`
Expected: `dist/` contains `index.js`, `index.d.ts`, and one `<module>.js` + `<module>.d.ts` per src module (25), plus chunk files. Spot-check: `node -e "import('./dist/index.js').then(m => console.log(typeof m.ArtifactTree, typeof m.makeToolset))"` prints `function function` (the built output runs under plain Node).

- [ ] **Step 5: Full suite + typecheck + commit**

Run: `npm test && npm run typecheck` (all green; `dist/` is gitignored and outside tsconfig `include`, so nothing changes for the source suite), then:

```bash
git add tsup.config.ts package.json package-lock.json
git commit -m "feat: tsup build to dist (ESM + dts) + exports map (root barrel + ./* subpaths)"
```

---

### Task 3: Pack-and-run capstone — the tarball works in plain Node ESM

**Files:**
- Test: `test/m11-packaging.test.ts`

- [ ] **Step 1: Write `test/m11-packaging.test.ts`**

```ts
import { describe, it, expect, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const work = mkdtempSync(join(tmpdir(), "arbor-m11-pack-"));

const SMOKE = `
import { ArtifactTree, Addressing, EventLog, Mutator, makeToolset, sizeBasedDecision, SeqIdGen, SystemClock, serializeArtifact, restoreArtifact, MemoryStorage, MemoryVectorIndex } from "arbor";
import { Replay } from "arbor/replay";

const deps = { idGen: new SeqIdGen(), clock: new SystemClock(), decision: sizeBasedDecision(1) };
const tree = ArtifactTree.fromJson({ pages: {} }, deps);
const addressing = new Addressing(tree);
const log = new EventLog();
const mutator = new Mutator(tree, addressing, log, { clock: deps.clock });

const tools = makeToolset({ tree, addressing, log, mutator }, { owner: "smoke", writeScope: "/pages" });
const ins = await tools.patch({ path: "/pages" }, { op: "insert", key: "home", value: { title: "Home" } });
if (!ins.ok) throw new Error("insert failed: " + JSON.stringify(ins));
const got = await tools.get({ path: "/pages/home" });
if (!got.ok || got.value.content.title !== "Home") throw new Error("get failed");
const refused = await tools.patch({ path: "/secret" }, { op: "set", value: 1 });
if (refused.ok) throw new Error("scope violation not refused");

const store = new MemoryStorage();
await store.save(serializeArtifact(tree, log, new MemoryVectorIndex()));
const loaded = await store.load();
const { tree: rtree } = restoreArtifact(loaded, deps, new MemoryVectorIndex());
if (JSON.stringify(rtree.toJson()) !== JSON.stringify(tree.toJson())) throw new Error("roundtrip failed");

const replay = new Replay(tree, log);
const before = replay.getAt("/pages/home", 0);
if (before !== undefined) throw new Error("expected node absent at v0");

console.log("SMOKE_OK");
`;

describe("M11 capstone: packed tarball runs in plain Node ESM (no bundler, no aliases)", () => {
  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it("npm pack → install into a bare fixture → smoke script passes", () => {
    // 1. pack (prepack runs the build)
    execSync(`npm pack --pack-destination "${work}"`, { cwd: repoRoot, stdio: "pipe", timeout: 180_000 });
    const tarball = readdirSync(work).find((f) => f.endsWith(".tgz"));
    expect(tarball).toBeDefined();

    // 2. bare ESM fixture — no TypeScript, no tsconfig, no aliases
    const fixture = join(work, "fixture");
    execSync(`node -e "require('fs').mkdirSync('${fixture.replace(/\\/g, "/")}', {recursive:true})"`, { stdio: "pipe" });
    writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "smoke", private: true, type: "module" }));
    writeFileSync(join(fixture, "smoke.mjs"), SMOKE);
    execSync(`npm install --no-audit --no-fund "${join(work, tarball!)}"`, { cwd: fixture, stdio: "pipe", timeout: 180_000 });

    // 3. run the smoke under plain node
    const out = execSync("node smoke.mjs", { cwd: fixture, encoding: "utf8", timeout: 60_000 });
    expect(out).toContain("SMOKE_OK");
  }, 300_000);
});
```

- [ ] **Step 2: Run the capstone**

Run: `npx vitest run test/m11-packaging.test.ts`
Expected: PASS (~30–60s: build + pack + install + run). This is the milestone's proof: the tarball resolves `"arbor"` AND `"arbor/replay"` under plain Node ESM. If it fails on import resolution, the exports map or the tsup entry layout is wrong — fix THOSE, not the test. (Offline-safe: the tarball has zero runtime deps, so `npm install` needs no registry.)

- [ ] **Step 3: Full suite + typecheck + commit**

Run: `npm test && npm run typecheck` (all green — the capstone adds ~1 slow test), then:

```bash
git add test/m11-packaging.test.ts
git commit -m "test: M11 pack-and-run capstone (tarball works in plain Node ESM)"
```

---

### Task 4: README + downstream verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add an "Install as a package" section to `README.md`** (insert after the "Develop" section):

```markdown
## Install as a package

Arbor builds to `dist/` (ESM + type declarations):

```bash
npm run build      # tsup → dist/
npm pack           # → arbor-1.0.0.tgz (prepack builds automatically)
# in a consumer project:
npm install /path/to/arbor-1.0.0.tgz
```

```ts
import { ArtifactTree, Mutator, makeToolset } from "arbor"; // barrel
import { Replay } from "arbor/replay";                      // or per-module subpaths
```

ESM-only, Node ≥ 20.6, zero runtime dependencies. `private: true` is kept until a
public registry name is chosen (`arbor` is taken on npm; publishing would use a
scoped name). Consumers that alias `arbor/*` to this repo's `src/*` via tsconfig
paths keep working unchanged — only the npm tarball is restricted to `dist/`.
```

- [ ] **Step 2: Update the README "Status" section** — replace the current Status paragraph's first line with:

```markdown
**v1 core complete (M1–M9), hardened (M10), packaged (M11):** tree, mutations + reversible log, optional types, exact navigation, semantic index, storage, replay/time-travel, scoped agent toolset, end-to-end scenario, index-lifecycle hardening, and an installable ESM build.
```

(Keep the existing "Deferred (post-v1)" line, removing "DB-backed storage…" nothing — just leave the deferred list as is.)

- [ ] **Step 3: Verify the downstream consumer is untouched**

Run: `npm --prefix c:\code\seo\content-generator-arbor test` and `npm --prefix c:\code\seo\content-generator-arbor run typecheck`
Expected: 193 tests green + clean — it consumes `src/` via tsconfig paths, which M11 does not move or change. (`src/index.ts` is additive; the alias `arbor/*` now also resolves `arbor/index` — harmless.)

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: install-as-a-package section + status (M10 hardened, M11 packaged)"
```

---

## Milestone 11 — Definition of Done

- [ ] `npm test` — all green (246 prior + capstone) and `npm run typecheck` clean.
- [ ] `npm run build` produces `dist/` with per-module JS + d.ts; `npm pack` produces a tarball (prepack builds).
- [ ] **The packed tarball installs into a bare Node ESM project and the smoke script passes** — both `import ... from "arbor"` and `from "arbor/replay"` resolve with types available.
- [ ] Downstream content-generator-arbor still green (tsconfig-paths consumption unchanged).
- [ ] README documents install/use; Status reflects M10+M11.

## Roadmap: next

- **M12 — Growth:** event-log compaction/checkpointing + delta persistence (write only events since last save) — the remaining big item from the review.
- **Publishing decision (when needed):** flip `private`, pick a scoped name (`arbor` is taken on the public registry), add LICENSE, `npm publish`.
- Later: tag/type indexes for `find`, `stats()`/`subscribe`, ANN `VectorIndexPort` adapter.

---

## Self-Review

**Spec coverage:** review finding "no exports/build — consumable only via tsconfig-paths" → Tasks 1–3 (barrel, build+exports, tarball proof); "installable, versionable" → version 1.0.0 + files+exports + pack capstone; downstream-unbroken requirement → Task 4 step 3; honest publish status (name taken, private kept) → Task 4 README + Scope. Deferred items listed in Roadmap.

**Placeholder scan:** none — full code in every step, exact commands + expected results; the only conditional instruction (barrel collision resolution) specifies the exact mechanism (named re-exports) and requires reporting.

**Type consistency:** the barrel re-exports exactly the 25 modules listed by `ls src/` (verified against the repo before writing); the exports map's `"./*"` matches tsup's one-entry-per-module output (`entry: ["src/*.ts"]`); the capstone's smoke imports only symbols asserted present by the Task 1 barrel test (`ArtifactTree`, `makeToolset`, `serializeArtifact`, `restoreArtifact`, `MemoryStorage`, `MemoryVectorIndex`, `SeqIdGen`, `SystemClock`, `sizeBasedDecision`) plus the `arbor/replay` subpath (`Replay`); `getAt(path, 0)` returning `undefined` for a not-yet-inserted node matches M7's contract. `npm pack` + `private: true` compatibility is real (private blocks publish only). `dist/` is already in `.gitignore` (verified).
