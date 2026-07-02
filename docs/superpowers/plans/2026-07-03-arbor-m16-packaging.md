# Arbor — M16: Publish Packaging (`arborkit`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Arbor publishable as **`arborkit`** (npm name verified free 2026-07-03; `arbor` is taken and the family is crowded — npm's own `@npmcli/arborist`): rename + full package metadata, no chunk leakage in exports, LICENSE/CHANGELOG/CI, a README quickstart rewritten against the facade with package-name imports, plus two facade ergonomics fixes from the M15 review (initial content is searchable; `saveDelta` before any checkpoint auto-checkpoints instead of writing an unrestorable journal). The brand stays **Arbor** everywhere in prose; only the package/import name is `arborkit`.

**Architecture:** No core changes except the two small facade fixes. Packaging: `splitting: false` in tsup (28 small modules gain nothing from chunks, and hash-named `chunk-*.js` files under the `"./*"` exports map are accidental public API). `private: true` is REMOVED — publishable, but actually publishing (`npm publish`) remains a manual user action.

**Tech Stack:** Node ≥20.6, TypeScript ESM, Vitest, tsup. No new runtime deps.

---

## Task 1: Facade ergonomics (M15 review minors #1 and #3)

**Files:** modify `src/arbor.ts`; extend `test/m15-facade.test.ts`

- [ ] **Step 1 — failing tests.** Append to the `describe("M15 createArbor facade", ...)` block in `test/m15-facade.test.ts`:

```ts
  it("initial content is indexed: searchable after the first reindex, no mutation needed", async () => {
    const arbor = createArbor(opts({ initial: { docs: { a: "initial searchable text" } }, embedding: new MockEmbeddingPort() }));
    expect(arbor.index!.staleCount()).toBeGreaterThan(0); // initial nodes queued
    await arbor.index!.reindex();
    const hits = await arbor.index!.search("initial searchable text");
    expect(hits.results[0]!.path).toBe("/docs/a"); // pre-fix: no results ever
  });

  it("saveDelta before any checkpoint auto-checkpoints (journal alone is unrestorable)", async () => {
    const delta = new MemoryDeltaStorage();
    const a1 = createArbor(opts({ initial: { page: "" }, delta }));
    a1.mutator.set({ path: "/page" }, "v1");
    await a1.saveDelta(); // no checkpoint yet — must snapshot instead of appending into the void
    const a2 = await restoreArbor(opts({ delta }));
    expect(a2).not.toBeNull(); // pre-fix: null (journal without checkpoint)
    expect(a2!.tree.toJson()).toEqual({ page: "v1" });
  });
```

Run `npx vitest run test/m15-facade.test.ts` → the two new tests FAIL (no results / restore null).

- [ ] **Step 2 — fix `src/arbor.ts`.**
  (a) In `createArbor`, after building the facade, seed the index from the initial tree. Change the end of `createArbor` to:

```ts
export function createArbor(opts: ArborOpts = {}): Arbor {
  const deps = buildDeps(opts);
  const tree = ArtifactTree.fromJson(opts.initial ?? {}, deps);
  const log = new EventLog();
  const vectors = opts.vectors ?? new MemoryVectorIndex();
  const arbor = assemble(opts, tree, log, vectors, deps.clock);
  // Index the initial content: fromJson fires no hooks, so without this the
  // initial JSON would be unsearchable until first mutated.
  if (arbor.index) {
    for (const node of tree.allNodes()) arbor.index.onChange(node);
  }
  return arbor;
}
```

  (b) Track checkpoint existence in `assemble` and auto-checkpoint on a premature `saveDelta`. `assemble` gains a parameter `hasCheckpoint: boolean`; inside, `let checkpointed = hasCheckpoint;`; `checkpoint()` sets `checkpointed = true` after persisting; `saveDelta()` becomes:

```ts
    saveDelta: async () => {
      if (!opts.delta) throw new InvalidOpError("saveDelta(): no delta storage configured");
      if (!checkpointed) {
        // A journal with no checkpoint is unrestorable — snapshot instead.
        if (o !== undefined) { /* (no options here — inline the checkpoint body) */ }
        highWater = await persistCheckpoint(opts.delta, tree, log, vectors);
        checkpointed = true;
        return;
      }
      highWater = await persistDelta(opts.delta, log, highWater);
    },
```

(implement it as a plain call to the same logic `checkpoint()` uses — extract a local `async function doCheckpoint(keepLast?: number)` used by both). Call sites of `assemble`: `createArbor` passes `hasCheckpoint: false`; `restoreArbor` passes `true` on the delta path (a checkpoint necessarily exists) and `false` on the storage path.
  NOTE: `SemanticIndex.onChange` is public (used as a mutation hook) — no visibility change needed.

- [ ] **Step 3 — gate + commit.** Both new tests pass; full `npx vitest run` (322) green; typecheck clean.

```bash
git add src/arbor.ts test/m15-facade.test.ts
git commit -m "fix: facade indexes initial content; saveDelta auto-checkpoints when none exists"
```

## Task 2: Rename to `arborkit` + package metadata + no chunk leakage

**Files:** modify `package.json`, `tsup.config.ts`, `test/m11-packaging.test.ts`

- [ ] **Step 1 — package.json.** Set: `"name": "arborkit"`, `"version": "1.0.0"`, add `"description": "Arbor — a shared, typed, versioned JSON artifact tree for multi-agent systems: lazy navigation, scoped agent tools, exact + semantic indexing, reversible event log with time-travel, snapshot + delta persistence."`, `"keywords": ["agents", "multi-agent", "shared-state", "artifact", "json-tree", "event-sourcing", "time-travel", "semantic-search", "blackboard", "llm"]`, `"author": "D. A. Pominov <d.a.pominov@gmail.com>"`, `"license": "MIT"`. REMOVE the `"private": true` line. Keep `exports`/`files`/`main`/`module`/`types`/engines/scripts as-is.
- [ ] **Step 2 — tsup.config.ts.** Set `splitting: false` (multi-entry chunks become importable hash-named files through the `"./*"` exports map — accidental public API). Run `npm run build`; verify `ls dist/chunk-*.js` matches NOTHING and `dist/index.js`, `dist/arbor.js` exist.
- [ ] **Step 3 — m11 packaging test.** In `test/m11-packaging.test.ts`, update every `"arbor"` package-name reference to `"arborkit"`: the tarball filename pattern (npm pack emits `arborkit-1.0.0.tgz` now — locate the code that resolves the tarball name and make it version-agnostic or update it), the fixture's `dependencies`, and the smoke-script imports (`from "arborkit"`, `from "arborkit/replay"`). Do NOT weaken any assertion.
- [ ] **Step 4 — gate + commit.** `npx vitest run test/m11-packaging.test.ts` PASS; full suite green; `npm run typecheck` clean.

```bash
git add package.json tsup.config.ts test/m11-packaging.test.ts
git commit -m "feat!: publish as arborkit v1.0.0 (metadata, MIT, no private, no chunk exports)"
```

## Task 3: LICENSE + CHANGELOG + CI

**Files:** create `LICENSE`, `CHANGELOG.md`, `.github/workflows/ci.yml`

- [ ] **Step 1 — LICENSE** (MIT, verbatim with this holder — the user can correct the name in one line later):

```
MIT License

Copyright (c) 2026 D. A. Pominov

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2 — CHANGELOG.md.** One `## 1.0.0 — 2026-07-03` section summarizing the M1–M16 arc in ~15 bullets (tree+decomposition, typed nodes/Zod, navigator+glob find, semantic index, storage, replay/time-travel, scoped toolset, hardening M10, packaging M11, log compaction M12, delta persistence M13, hardening-2 M14, API polish + facade M15, arborkit packaging M16). Derive the wording from `git log --oneline` milestone commits; keep each bullet one line.
- [ ] **Step 3 — `.github/workflows/ci.yml`:**

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix: { node: [20, 22] }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "${{ matrix.node }}" }
      - run: npm ci
      - run: npm test
      - run: npm run typecheck
      - run: npm run build
```

- [ ] **Step 4 — commit.**

```bash
git add LICENSE CHANGELOG.md .github/workflows/ci.yml
git commit -m "docs: LICENSE (MIT), CHANGELOG 1.0.0, GitHub Actions CI"
```

## Task 4: README rewrite for the facade + package imports

**Files:** modify `README.md`

- [ ] **Step 1.** Rewrite the README top: title `# Arbor (\`arborkit\`)`, the one-paragraph pitch (shared, typed, versioned JSON artifact tree for multi-agent systems), install `npm install arborkit`.
- [ ] **Step 2.** Replace the quickstart with a `createArbor`-based one using PACKAGE imports (`import { createArbor, MockEmbeddingPort, MemoryDeltaStorage } from "arborkit";`): create with `initial` + `embedding` + `delta`, get a scoped `toolset`, patch/get, `reindex` + `search`, `saveDelta`, `restoreArbor`, `replay.getAt`. Keep it ~30 lines and RUNNABLE (verify each call against the real API — `patch` returns `{id,path,version}`, `find` returns `{hits,truncated}`).
- [ ] **Step 3.** Add short sections: **Lifecycle notes** (delta: first `saveDelta` auto-checkpoints; pair `checkpoint({keepLast})` with the compaction floor; restore needs the same `decompose`/`registry`) and **Format compatibility** (StoredArtifact v1 files from pre-M12 still load; v2 adds `baseSeq`). Update the Status line: append `, API polish + facade (M15), published as arborkit (M16)`.
- [ ] **Step 4.** Keep the existing "Scope & limits" section (update any `patch`/`find` return-shape examples inside if present). Commit:

```bash
git add README.md
git commit -m "docs: README — arborkit install, facade quickstart, lifecycle + format notes"
```

## Task 5: Capstone — pack-and-run as `arborkit`

**Files:** none new (the updated m11 packaging test IS the capstone) — this task is the full gate + a real-tarball facade smoke check.

- [ ] **Step 1.** Extend the m11 packaging smoke-script string with a facade call: after the existing imports add `import { createArbor } from "arborkit";` and a two-line check (`const a = createArbor({ initial: { x: 1 } }); if (JSON.stringify(a.tree.toJson()) !== '{"x":1}') throw new Error("facade smoke failed");`). Keep everything else.
- [ ] **Step 2.** Full gate: `npm test && npm run typecheck && npm run build`. Also `npm pack --dry-run` — verify the file list contains dist/ + LICENSE + README + CHANGELOG and NO src/tests/docs.
- [ ] **Step 3.** Commit:

```bash
git add test/m11-packaging.test.ts
git commit -m "test: packaging capstone — arborkit tarball facade smoke + publish file list"
```

---

## Definition of Done

- [ ] Suite green (~322+), typecheck clean, build green with zero `chunk-*.js` in dist.
- [ ] `package.json`: name `arborkit`, v1.0.0, metadata complete, `private` removed; `npm pack --dry-run` lists dist/LICENSE/README/CHANGELOG only.
- [ ] Facade: initial content searchable; premature `saveDelta` auto-checkpoints.
- [ ] LICENSE/CHANGELOG/CI exist; README quickstart is facade-based with `arborkit` imports and verified against the real API.
- [ ] The m11 packaging test installs the real tarball and imports `arborkit` + `arborkit/replay` + the facade.

## Roadmap after M16
Actual `npm publish` = manual user action (needs their npm account). Downstream `content-generator-arbor` adaptation to M15 breaking changes. P2: perf wins, typed-ancestor staleness + move hooks, AG-UI adapter.

## Self-Review
Coverage: rename/metadata/exports (T2), hygiene docs+CI (T3), README (T4), facade minors #1/#3 from the M15 review (T1), real-tarball proof (T5). Placeholders: none — Step 1 code blocks are complete; T4 references the real API shapes to verify against. Types: `saveDelta` refactor keeps the `Arbor` interface unchanged; `onChange(node)` is the existing public hook; m11 test changes are string/name-level only.
