# Arbor — M18: `edit` Patch Op (string surgery for agents) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give agents a token-cheap, precision edit primitive: `patch {op: "edit", old, new}` replaces an exact substring inside a STRING-valued node (e.g. a section's raw-HTML leaf) — the agent outputs ~100 tokens of arguments instead of regenerating a ~1500-token block, and cannot accidentally alter anything outside the quoted fragment. Output tokens are 5× input price on all current Claude models, so this is the dominant cost lever for agent-driven editing.

**Architecture:** Pure sugar over `Mutator.set` — zero new core semantics. The op resolves the node, verifies the value is a string, checks `old` occurs exactly once (or `replaceAll`), computes the new string, and calls the existing `mutator.set`. The event log records an ordinary `set` with full before/after, so replay, revert, delta persistence, and the AG-UI adapter all work unchanged. Scope/ifVersion enforcement comes free from the Mutator. Mirrors the semantics of Claude Code's `Edit` tool (unique `old_string` or fail loudly), which is the proven agent-editing pattern.

**Tech Stack:** TS/ESM, Vitest. Additive API → version **1.1.0**. Builds on M1–M17 (341 tests + bench).

---

## Task 1: The op + tests

**Files:** modify `src/toolset.ts`; create `test/m18-edit-op.test.ts`

- [ ] **Step 1 — failing tests `test/m18-edit-op.test.ts`** (setup mirrors `test/m15-toolset-returns.test.ts`: tree+addressing+log+mutator+`makeToolset`, `sizeBasedDecision(1)`):
  1. **Happy path:** tree `{docs: {a: "Bonus: 100% do 2000 PLN. Graj!"}}`; `patch({path:"/docs/a"}, {op:"edit", old:"100% do 2000 PLN", new:"150% do 3000 PLN"})` → `ok`, `PatchResult` has `path:"/docs/a"` and bumped `version`; `tree.toJson()` reflects the change; `log.at(0)!.kind === "set"` with full `before`/`after` strings (replay-able).
  2. **Not found:** `old:"nope"` → `ok:false`, `error.code === "INVALID_OP"`, message mentions not found; tree unchanged, log empty.
  3. **Ambiguous:** value `"aa bb aa"`, `old:"aa"` → INVALID_OP mentioning the occurrence count; with `replaceAll: true` → succeeds, value `"XX bb XX"`.
  4. **Guards:** `old:""` → INVALID_OP; `old === new` → INVALID_OP.
  5. **Non-string target:** edit on an object node (e.g. `/docs`) → INVALID_OP whose message hints at targeting a string field.
  6. **Scope:** toolset bound `writeScope:"/docs"`; edit on an out-of-scope string leaf → `SCOPE_VIOLATION`, unchanged.
  7. **ifVersion:** stale `ifVersion` → `STALE_VERSION`.
  8. **Time travel intact:** after a successful edit, `new Replay(tree, log).getAt("/docs/a", 0)`... (version before the edit) returns the ORIGINAL string.

- [ ] **Step 2 — run → FAIL** (unknown op / type error).

- [ ] **Step 3 — implement in `src/toolset.ts`.** Extend `PatchOp`:

```ts
  | { op: "edit"; old: string; new: string; replaceAll?: boolean; ifVersion?: number }
```

Add the case to the `patch` switch (after `move`; `resolve`, `tree`, `addressing`, `common`, `InvalidOpError` are all already in scope):

```ts
          case "edit": {
            const node = resolve(ref);
            const path = addressing.pathOf(node.id);
            const value = tree.toJson(node.id);
            if (typeof value !== "string") {
              const kind = Array.isArray(value) ? "an array" : typeof value;
              throw new InvalidOpError(
                `edit targets string values; ${path} is ${kind} — target a string field inside it`,
              );
            }
            if (op.old === "") throw new InvalidOpError("edit: old must be non-empty");
            if (op.old === op.new) throw new InvalidOpError("edit: old and new are identical");
            const count = value.split(op.old).length - 1;
            if (count === 0) throw new InvalidOpError(`edit: old string not found in ${path}`);
            if (count > 1 && !op.replaceAll) {
              throw new InvalidOpError(
                `edit: old string occurs ${count} times in ${path} — quote a larger unique fragment or set replaceAll`,
              );
            }
            const next = op.replaceAll ? value.split(op.old).join(op.new) : value.replace(op.old, op.new);
            deps.mutator.set(ref, next, common);
            const after = resolve(ref);
            return { id: after.id, path: addressing.pathOf(after.id), version: after.meta.version };
          }
```

Update the `PatchOp` doc comment: `edit` = exact-substring surgery on a string leaf; recorded as a plain `set` (full before/after) so history/revert/AG-UI need nothing new; the agent should `get` the node first and quote `old` from the live value.

- [ ] **Step 4 — gate.** New tests pass; FULL `npx vitest run` (341 + 8 ≈ 349) green; `npm run typecheck` clean. Note: the facade's `toolset()` and any consumer of `PatchOp` get the op automatically (additive union member — no other file changes).

- [ ] **Step 5 — commit:** `feat: patch op "edit" — exact-substring surgery on string leaves (agent-cheap edits, plain set under the hood)`

## Task 2: Version 1.1.0 + docs

**Files:** `package.json`, `CHANGELOG.md`, `README.md`

- [ ] `package.json` version → `1.1.0`.
- [ ] `CHANGELOG.md` → `## 1.1.0 — <date>` section: the `edit` op, its semantics (unique-or-replaceAll, string leaves only, ordinary `set` event), and the motivation (output tokens are 5× input; agents edit blocks without regenerating them).
- [ ] `README.md`: in the toolset/quickstart area add a 5-line "Agent edits" snippet showing `patch {op:"edit"}` on a section's html leaf, with the get-first-quote-old rule.
- [ ] Gate: full suite + typecheck + `npm run build`; `npm pack --dry-run` sanity. Commit: `chore: release 1.1.0 (edit op)`. **`npm publish` = manual user action.**

## Definition of Done
- [ ] `patch {op:"edit"}` behaves per the 8 test cases; suite ~349 green; build clean; 1.1.0 staged for publish.
- [ ] No event-log/replay/delta/AG-UI changes needed (verified by test 8 + full suite).

## Out of scope
Regex/multi-edit batches; edits INSIDE opaque object leaves (agent targets the string field; if a generator's decomposition keeps `html` inside an opaque object, the consumer should tune decomposition or use `set`); HTML awareness (that's the consumer's wrapper — see the generator's editor-agent plan).
