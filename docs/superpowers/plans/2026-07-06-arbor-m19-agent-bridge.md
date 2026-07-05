# Arbor — M19: Agent Bridge (tool defs + executor + getAt/revert tools) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship the generic 80% of an LLM↔Arbor bridge inside arborkit itself — ready-made tool definitions (JSON Schema, zero-dep) + a never-throw executor with a guard hook — so a consumer hands their agent a working toolset in ~3 lines instead of rewriting the ~300-line bridge the SEO generator had to build by hand. Also closes the long-deferred `getAt`/`revert` toolset methods (an editing agent can then "undo the last change" natively).

**Architecture:** Two additive layers. (1) `Toolset` gains `getAt`/`revert` — thin wrappers over the existing `Replay`, with the same scope discipline the other methods have (`getAt` = read → readScope; `revert` = write → writeScope pre-checked exactly like `edit` does, because `Replay.revert`'s internal `mutator.set` carries no binding). (2) New module `src/agent-tools.ts`: `agentToolDefs()` (data only — `{name, description, schema}` with hand-written JSON Schema objects; the same shape LangChain `bindTools` accepts as-is and the Anthropic SDK accepts after a one-line field rename) + `makeToolExecutor(toolset, opts)` (dispatch + minimal input validation + guard hook + size cap + never-throw serialization). Domain-specific guards (e.g. an HTML tag-balance check) stay with the consumer via the `guard` hook.

**Tech Stack:** TS/ESM, Vitest, zero runtime deps (schemas are plain object literals — NO zod, NO json-schema lib). Additive API → version **1.2.0**. Builds on M1–M18 (359 tests).

**Provenance:** The tool descriptions, never-throw executor semantics, TOO_LARGE cap, and guard-hook shape are the reviewed-and-shipped design of the SEO generator's bridge (`seo_ai_platform/content-generator-arbor/src/lib/arbor-tools.ts`, tasks B1 of its editor-agent plan) — minus its HTML-specific tag-balance guard, which is exactly what the `guard` hook exists for.

---

## Task 1: `getAt` + `revert` as toolset methods

**Files:** modify `src/toolset.ts`; create `test/m19-toolset-timetravel.test.ts`

- [ ] **Step 1 — failing tests** (setup mirrors `test/m18-edit-op.test.ts`: tree+addressing+log+mutator+`makeToolset`, `sizeBasedDecision(1)`):
  1. **getAt happy:** build `{docs:{a:"v1"}}`, capture `v = log.length()`, set `/docs/a` to `"v2"`; `getAt({path:"/docs/a"}, v)` → `ok`, `value === {value:"v1", existed:true}`; current tree still `"v2"`.
  2. **getAt before existence:** `getAt({path:"/docs/a"}, 0)` on a node inserted later → `{value:null, existed:false}`.
  3. **getAt readScope:** toolset bound `readScope:"/docs"`; `getAt({path:"/other"}, …)` → `SCOPE_VIOLATION`.
  4. **getAt below compaction floor:** `log.compactTo(n)` then `getAt(…, versionBelowFloor)` → `INVALID_OP` (message mentions compacted history), never throws.
  5. **revert happy:** set `"v2"` then `revert({path:"/docs/a"}, v)` → `ok`, PatchResult `{id, path:"/docs/a", version}`; `tree.toJson()` shows `"v1"`; the log grew (append-only — a NEW set event, prior history intact).
  6. **revert writeScope:** bound `writeScope:"/docs"`; revert on an existing out-of-scope path → `SCOPE_VIOLATION`, tree unchanged. (Pre-check like `edit` — `Replay.revert` itself carries no binding.)
  7. **revert restores type+tags:** typed node reverted across a type-changing set gets its old type back (assert via `tree`/`get` meta — reuse the m14 stateAt test fixture pattern).

- [ ] **Step 2 — run → FAIL** (methods don't exist).

- [ ] **Step 3 — implement in `src/toolset.ts`.** Extend the `Toolset` interface:

```ts
  /** Value of `ref` as of `version` (event-log seq). Read-only time travel; readScope applies. */
  getAt(ref: Ref, version: number): Promise<ToolResult<{ value: Json | null; existed: boolean }>>;
  /** Restore `ref` to its value/type/tags as of `toVersion`, as a NEW append-only mutation. writeScope applies. */
  revert(ref: Ref, toVersion: number): Promise<ToolResult<PatchResult>>;
```

Implementation inside `makeToolset` (a `Replay` is constructed once: `const replay = new Replay(deps.tree, deps.log);` — import from `./replay`; `run()` wrapper + `resolve` + scope helpers are already there; mirror how `history` checks readScope and how `edit` pre-checks writeScope):

```ts
    getAt: (ref, version) =>
      run(() => {
        const node = resolve(ref);
        const path = addressing.pathOf(node.id);
        checkRead(path); // same readScope check the other read methods use — reuse the existing helper/inline pattern
        const past = replay.getAt(path, version); // throws InvalidOpError below the compaction floor → run() maps it
        return { value: (past ?? null) as Json | null, existed: past !== undefined };
      }),
    revert: (ref, toVersion) =>
      run(() => {
        const node = resolve(ref);
        const path = addressing.pathOf(node.id);
        if (binding.writeScope !== undefined && !isWithin(path, binding.writeScope))
          throw new ScopeViolationError(path, binding.writeScope);
        replay.revert(deps.mutator, addressing, { path }, toVersion);
        const after = resolve({ path });
        return { id: after.id, path, version: after.meta.version };
      }),
```

Adapt names to the file's actual internals (`binding`, read-check helper) — semantics above are the spec. Update the file-top doc comment listing the toolset methods.

- [ ] **Step 4 — gate:** new tests pass; FULL `npx vitest run` green; `npm run typecheck` clean.
- [ ] **Step 5 — commit:** `feat: toolset getAt/revert — scoped time-travel reads and append-only undo for agents`

## Task 2: `src/agent-tools.ts` — tool defs + executor

**Files:** create `src/agent-tools.ts`; create `test/m19-agent-tools.test.ts` (barrel `src/index.ts` picks the module up via the existing `export *` pattern — add the line; package.json exports map gains `"./agent-tools"` alongside its 30 siblings)

- [ ] **Step 1 — failing tests:**
  1. **Defs shape:** `agentToolDefs()` returns 9 defs (`search, find, describe, get, edit, set_value, history, get_at, revert`), each `{name, description, schema}`, every schema a plain object with `type:"object"`, `properties`, and `required` listing only keys present in `properties`; `agentToolDefs({include:["get","edit"]})` returns exactly those two.
  2. **Executor happy paths:** real toolset over `{pages:{home:{title:"Home", html:"<p>Bonus: 2000 PLN</p>"}}}` (writeScope `/pages`); `get` returns JSON containing the content; `edit` (`old:"2000 PLN"`, `new:"3000 PLN"`) mutates the leaf; `get_at` with a pre-edit version returns the old string; `revert` restores it; all results are valid-JSON strings of `ToolResult` shape.
  3. **Error passthrough:** ambiguous `edit` (old occurs twice) → returned string contains `INVALID_OP` and the occurrence count; nothing thrown.
  4. **Guard hook:** `makeToolExecutor(toolset, {guard})` where guard refuses `edit` when `input.new` contains `"FORBIDDEN"` → returned JSON is `{ok:false, error:{code:"GUARD_REFUSED", …}}` (the guard's own code/message), toolset NOT called (value + version unchanged); guard returning `null` lets the call through; guard is NOT invoked for tools it doesn't refuse (call-count spy).
  5. **TOO_LARGE:** executor with `{maxResultChars: 50}`; `get` on a node whose serialized result exceeds it → `TOO_LARGE` with actionable message (mentions narrowing/`maxDepth`); error results pass through uncapped (scope violation still readable with cap 10).
  6. **UNKNOWN_TOOL** (message lists available names) and **INVALID_INPUT** (e.g. `edit` without `old`; `get_at` with string `version`).
  7. **EXECUTOR_ERROR never throws:** stub toolset whose `get` throws `null` → serialized `EXECUTOR_ERROR`, message `"null"`.

- [ ] **Step 2 — run → FAIL.**

- [ ] **Step 3 — implement.** Module skeleton (complete — adapt only if a listed signature collides with an existing export):

```ts
import type { Toolset } from "./toolset";
import type { Json } from "./types";

/** Plain-JSON tool definition. LangChain's bindTools accepts this shape as-is;
 *  for the Anthropic SDK map it: {name, description, input_schema: schema}. */
export interface AgentToolDef {
  name: string;
  description: string;
  schema: Record<string, unknown>; // JSON Schema (object literal — no runtime dep)
}

export type AgentToolName =
  | "search" | "find" | "describe" | "get"
  | "edit" | "set_value" | "history" | "get_at" | "revert";

export const DEFAULT_MAX_RESULT_CHARS = 20_000;

/** Pre-execution veto for domain rules (e.g. an HTML tag-balance check).
 *  Return null to allow; return {code, message} to refuse — the refusal is
 *  serialized back to the agent as {ok:false, error} and the toolset is NOT called. */
export type ToolGuard = (
  toolName: AgentToolName,
  input: Record<string, unknown>,
) => { code: string; message: string } | null;
```

`agentToolDefs(opts?: {include?: AgentToolName[]})` — the 9 defs verbatim (descriptions are load-bearing; keep them):

| name | description (exact) | schema properties / required |
|---|---|---|
| `search` | `Semantic search over the artifact by MEANING. Use this FIRST to locate content when you don't know its path.` | `query:string` (req), `k:integer` |
| `find` | `Exact lookup by path glob, type, or tag. Returns {hits, truncated} — truncated=true means narrow the pattern.` | `pathPattern:string`, `type:string`, `tag:string`, `limit:integer` |
| `describe` | `Structure overview of a node: children, types, sizes. Start here to orient before reading values.` | `path:string` |
| `get` | `Full value of a node. ALWAYS get the target immediately before editing and quote "old" from the EXACT text returned. Use maxDepth to bound large subtrees.` | `path:string` (req), `maxDepth:integer` |
| `edit` | `THE default write: replace an exact substring inside a string value. Never rewrite a whole block for a small change. "old" must occur exactly once — on an ambiguity error, re-quote a larger unique fragment or set replaceAll.` | `path:string` (req), `old:string` (req), `new:string` (req), `replaceAll:boolean` |
| `set_value` | `Replace a node's entire value. Expensive and rarely needed — prefer edit for changes inside existing content.` | `path:string` (req), `value:{}` (any JSON; req) |
| `history` | `Recent mutation events for a node (who changed what, before/after).` | `path:string`, `limit:integer` |
| `get_at` | `Value of a node as of a past version (event-log seq). Read-only time travel.` | `path:string` (req), `version:integer` (req) |
| `revert` | `Restore a node to its value at a past version, as a NEW change (history is append-only — nothing is lost). Use get_at first to confirm the target state.` | `path:string` (req), `version:integer` (req) |

`makeToolExecutor(toolset: Toolset, opts?: {maxResultChars?: number; guard?: ToolGuard}): (toolName: string, input: unknown) => Promise<string>`:

- Unknown name → `{ok:false, error:{code:"UNKNOWN_TOOL", message:"unknown tool <n>; available: <list>"}}`.
- Input not a plain object, or a required field missing / wrong `typeof` (hand-rolled per-tool checks against the table above — a small `requireString/requireInt` pair of helpers, NOT a JSON-Schema validator) → `INVALID_INPUT` naming the field.
- `guard` (if provided) runs after validation, before dispatch; a non-null return short-circuits to `{ok:false, error}`.
- Dispatch map onto the toolset: `search→toolset.search(query,{k})`, `find→toolset.find(selector,{limit})`, `describe/get→navigator methods via toolset`, `edit→toolset.patch({path},{op:"edit",old,new,replaceAll})`, `set_value→patch {op:"set"}`, `history→toolset.history({path},{limit})`, `get_at→toolset.getAt({path},version)`, `revert→toolset.revert({path},version)`. (Exact call shapes: read `src/toolset.ts` — e.g. `find`'s selector/opts split.)
- `try/catch` around dispatch: `err instanceof Error ? err.message : String(err)` → `EXECUTOR_ERROR` (belt-and-braces — the toolset itself never throws).
- Serialize the entire `ToolResult`; if `result.ok === true` and the string exceeds the cap → replace with `TOO_LARGE` error telling the agent to narrow the path / lower `maxDepth` / reduce `k`. Error results are never capped.

Module doc comment: 5-line usage sketch (defs → `bindTools` / Anthropic mapping; executor in the tool-call loop; guard for domain rules).

- [ ] **Step 4 — gate:** new tests pass; FULL suite green; typecheck clean; `npm pack --dry-run` includes `dist/agent-tools.*` (entry auto-picked by `entry:["src/*.ts"]`; verify the exports map addition).
- [ ] **Step 5 — commit:** `feat: agent bridge — zero-dep tool defs (JSON Schema) + never-throw executor with guard hook`

## Task 3: Version 1.2.0 + docs

**Files:** `package.json`, `CHANGELOG.md`, `README.md`

- [ ] `package.json` → `1.2.0` (exports map line for `./agent-tools` landed in Task 2).
- [ ] `CHANGELOG.md` → `## 1.2.0 — <date>`: agent bridge (defs + executor + guard hook, provenance note "extracted from a production consumer's reviewed bridge"), toolset `getAt`/`revert`.
- [ ] `README.md`: stack list — extend the Toolset bullet with `getAt`/`revert`; new bullet **Agent bridge** (`agentToolDefs` + `makeToolExecutor`, LangChain as-is / Anthropic one-line mapping, guard hook for domain rules); quickstart gains 4–6 lines (defs → executor → one `edit` round-trip); **Deferred list**: remove "LangChain `tool()` adapters" and "`getAt`/`revert` as toolset methods", keep "MCP-server adapter" and the rest.
- [ ] Smoke the README snippet as a script against the packed build (the m11/m18 pattern: scratch fixture, `npm install <tarball>`, run).
- [ ] Gate: full suite + typecheck + build + `npm pack --dry-run`. Commit: `chore: release 1.2.0 (agent bridge, toolset time-travel)`. **`npm publish` = manual user action.**

## Definition of Done
- [ ] Toolset has scoped `getAt`/`revert` (7 test cases incl. compaction floor + scope + type/tags restore).
- [ ] `agentToolDefs`/`makeToolExecutor` cover the 7 executor test groups; zero new runtime deps (`package.json` dependencies stay absent).
- [ ] 1.2.0 staged; README/CHANGELOG updated; deferred list pruned; suite ≈ 359+16 green.

## Out of scope
MCP server (separate package, when a second non-Node/off-the-shelf consumer is real); zod/typed schemas (JSON Schema literals only); JSON-Schema *validation* (executor does minimal hand-rolled checks; the toolset's own errors are the real contract); porting the fork's HTML tag-balance guard (consumer-side, via `guard`); `insert`/`remove`/`move` as separate agent tools (available via the toolset's `patch` for code callers; add on demand).
