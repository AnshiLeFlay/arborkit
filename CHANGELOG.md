# Changelog

## 1.3.0 — 2026-07-14

- **Atomic toolset batches:** `Toolset.batchPatch(steps)` applies any combination
  of set/insert/remove/move/edit in one transaction and returns ordered
  `PatchResult[]`; any scope, validation, version, or operation failure restores
  the tree, versions, event log, and semantic queues.
- **Complete agent mutation surface:** new `insert`, `remove`, `move`, and
  `batch_patch` tools; `edit`, `set_value`, `insert`, `remove`, and `move` expose
  `ifVersion` so model-driven writes can use compare-and-set.
- **Safer capability presets:** `reader`, `editor`, and `admin` profiles for both
  definitions and executor. `include` intersects a profile and can never widen it.
  Calling both APIs with no options preserves the v1.2 nine-tool surface; new
  destructive tools require an explicit profile/include opt-in.
- Search tools now expose `under`, `type`, `tag`, and `freshness`; every tool
  definition includes an output JSON Schema for its complete `ToolResult`.
- Guards may be async and run per contained batch operation. A new async
  `approval` callback returns `APPROVAL_DENIED` before dispatch; all batch guards
  and approvals finish before the atomic write starts.

- Repositioned ArborKit as a versioned, searchable JSON workspace embedded in
  any agent runtime, with an explicit decision guide and architecture overview.
- Added a production-readiness checklist and integration patterns for
  LangChain/LangGraph, Anthropic, and Mastra.
- Added runnable research-artifact and provider-neutral runtime-bridge examples;
  `npm run example:all` now exercises all three documented product scenarios.
- Added reproducible TypeDoc API generation via `npm run docs:api` and its CI gate.

## 1.2.1 — 2026-07-06

Feedback round from the first production consumer adopting `arborkit/agent-tools`
(the module's own round-trip validation), plus one robustness guard:

- **`makeToolExecutor` gains `include`** — the executor's dispatch surface can now
  match the bound tool subset: calls outside `include` return `UNKNOWN_TOOL`
  listing only the enabled names (previously a consumer binding six defs had an
  executor that silently dispatched all nine — including `revert`, a write).
  Absent `include` = all nine, message unchanged (back-compatible).
- **`set_value` rejects `value: undefined`** — previously an explicit undefined
  passed the key-presence check and was WRITTEN into the tree. `null` remains a
  valid value (it is valid Json); only undefined is rejected.
- **Shared leaf schema constants are frozen** — mutating e.g.
  `properties.path` on a returned def contaminated every other def and every
  future `agentToolDefs()` call. Defs stay safe to EXTEND (clone-and-augment,
  adding new keys) — the documented consumer pattern is unaffected.
- **`Addressing.pathOf` throws on parent-chain cycles** (`INVALID_OP`) instead of
  hanging in a synchronous infinite loop — insurance against any future
  corruption vector; valid trees are unaffected.
- Package metadata now points at the GitHub repository
  (github.com/AnshiLeFlay/arborkit).

## 1.2.0 — 2026-07-06

- **Agent bridge: `agentToolDefs` + `makeToolExecutor`** (new module
  `arborkit/agent-tools`, also in the root barrel) — the generic extraction of a
  production consumer's reviewed LLM↔Arbor bridge:
  - `agentToolDefs()` returns 9 ready-made tool definitions (`search`, `find`,
    `describe`, `get`, `edit`, `set_value`, `history`, `get_at`, `revert`) as
    plain JSON Schema object literals — zero runtime deps. LangChain's
    `bindTools` accepts them as-is; the Anthropic SDK needs one line:
    `defs.map((d) => ({ name: d.name, description: d.description, input_schema: d.schema }))`.
  - `makeToolExecutor(toolset, opts?)` returns a never-throw
    `(toolName, input) → Promise<JSON string>` dispatcher for the tool-call
    loop: `UNKNOWN_TOOL` / `INVALID_INPUT` on bad calls, `TOO_LARGE` with a
    narrow-and-retry hint when an ok result exceeds `maxResultChars` (default
    `DEFAULT_MAX_RESULT_CHARS` = 20 000; error results are never capped), and
    `EXECUTOR_ERROR` as the belt-and-braces catch-all. The toolset's own
    structured errors (scope violations, ambiguous edits, …) pass through
    serialized.
  - `guard` hook (`ToolGuard`) — a pre-execution veto for domain rules (e.g. an
    HTML tag-balance check): return `{code, message}` to refuse (serialized back
    as `{ok: false, error}`; the toolset is NOT called) or `null` to allow.
- **Toolset `getAt`/`revert`** — scoped time-travel read + append-only undo,
  closing the long-deferred item. `getAt(ref, version)` returns
  `{value, existed}` as of a past event-log seq (readScope applies; below the
  compaction floor it returns `INVALID_OP`, never throws). `revert(ref, toVersion)`
  restores the node's value/type/tags as a NEW append-only mutation — prior
  history stays intact (writeScope pre-checked like `edit`, since
  `Replay.revert` itself carries no binding). Both are path-addressed at the
  node's CURRENT path — for an `{id}` ref of a since-moved node they operate on
  what occupied its current path back then, not the node's old location.
  NOTE: `revert` takes no `ifVersion` — a concurrent write landing between an
  agent's `get_at` check and its `revert` is not CAS-guarded. The revert's
  outcome is deterministic regardless (it restores the state at `toVersion`);
  an `ifVersion` guard can be added later if demanded.

## 1.1.1 — 2026-07-06

- **Fix: `restoreArtifact` now guards against id collisions.** A deterministic
  `idGen` (e.g. a sequence generator) restarted in a new process could re-mint
  ids already used by restored nodes; the next mutation then silently
  overwrote a live node (up to corrupting the parent chain into a cycle). The
  restore now seeds an id guard from the stored node ids — the same protection
  the delta path always had, now shared as the exported `guardIdGen(idGen, used)`
  (also consolidates two previous inline copies).
- **Fix: nested `embedText` staleness propagates outward.** A write inside a
  nested embedText unit re-marked only the nearest unit; every embedText-typed
  ancestor is now re-hashed, so outer units no longer go silently stale.
  (Pre-fix, even *inserting* a typed inner unit permanently diverged the outer
  unit's text hash, blocking it from ever settling back to fresh.) Unaffected
  ancestors settle back to fresh via the existing hash compare — no spurious
  re-embeds.
- Docs (README): AG-UI adapter and the `edit` op surfaced in the stack overview
  and quickstart; status covers M17–M18; retroactive M17 entries added to the
  1.0.0 changelog section below.

## 1.1.0 — 2026-07-05

- **New patch op: `edit`** — exact-substring surgery on string-valued nodes:
  `patch(ref, { op: "edit", old, new, replaceAll?, ifVersion? })`. `old` must occur
  exactly once in the node's string value (or set `replaceAll`); on a miss or an
  ambiguous match the op fails with a structured `INVALID_OP` that reports the
  occurrence count, so an agent can re-quote a larger fragment and retry.
  Replacement is literal (no `$&`-style pattern expansion). Scope and `ifVersion`
  are enforced *before* any content inspection — out-of-scope probes get an
  identical `SCOPE_VIOLATION` whether or not `old` matches, leaking nothing.
- Under the hood `edit` is pure sugar over `set`: the event log records an ordinary
  `set` with full before/after, so replay, revert, delta persistence, and the AG-UI
  adapter need no changes.
- Motivation: output tokens are ~5× input price on current Claude models. An agent
  quoting `old`/`new` fragments (~100 output tokens) instead of regenerating a whole
  block (~1500) is the dominant cost lever for agent-driven editing. Pattern: `get`
  the node first, quote `old` from the live value — the Claude Code `Edit`-tool
  semantics.

## 1.0.1 — 2026-07-03

- **Fix: cross-entry `instanceof` breakage.** 1.0.0 was built without code splitting, so every
  subpath entry (`arborkit/errors`, `arborkit/toolset`, …) bundled its own copies of shared
  classes — mixing root and subpath imports broke `instanceof` (e.g. the toolset degraded
  `SCOPE_VIOLATION` results to generic `ERROR` against a `Mutator` imported from another entry).
  Splitting is now enabled; shared chunks give one class identity across all entries.
- Chunk files stay private: the `"./*"` wildcard export is replaced by an explicit per-module
  exports map, so hash-named chunks are not importable. All documented entry points are unchanged.

## 1.0.0 — 2026-07-03

First public release of Arbor as `arborkit`. The milestone arc:

- Artifact tree with size/type-aware decomposition — large JSON splits into addressable nodes automatically (M1–M2).
- Typed nodes via a Zod adapter and a pluggable type registry (M3).
- Lazy navigator with glob-based `find` over paths, types, and tags (M4).
- Per-node semantic index with a stale-node lifecycle and batched `reindex` (M5).
- Snapshot persistence: `serializeArtifact`/`restoreArtifact` over a `StoragePort` (memory + atomic file impls) (M6).
- Reversible event log with value-level replay: `getAt`, `diff`, time-travel, and `revert` (M7).
- Scoped agent toolset — `describe`/`get`/`patch`/`find`/`search`/`history` with structured results and read/write scopes (M8).
- End-to-end content-site scenario plus a runnable example (M9).
- Hardening round 1: tx rollback restores index state, deep-cloned tool results, atomic file saves, type-aware revert (M10).
- Packaging: ESM build via tsup, exports map, pack-and-run capstone in plain Node (M11).
- Opt-in event-log compaction: `compactTo` + `baseSeq` sliding window, floor-aware replay, StoredArtifact v2 (v1 files still load) (M12).
- Delta persistence: checkpoint + appendable NDJSON journal with forward-replay restore (`DeltaStoragePort`, memory + file impls) (M13).
- Hardening round 2: move guards, aliasing hygiene, interleave-safe reindex, tags recorded in events, move-aware revert (M14).
- API polish: async `VectorIndexPort`, `patch` returns `{id, path, version}`, `find` returns `{hits, truncated}`, single `isWithin` scope helper (M15).
- `createArbor`/`restoreArbor` facade — one-call wiring, guarded restore, auto-checkpoint on first `saveDelta` — and published as `arborkit` (M15–M16).
- Performance overhaul: clone-once replay (~640× on long logs), O(1) child lookup by key, incremental glob `find`, Float32 normalized vectors (dot-product search; `number[]` persist format kept), plus `npm run bench` micro-benchmarks (M17).
- Zero-dep AG-UI adapter: `snapshotEvent`/`deltaSince`/`toJsonPatch` — STATE_SNAPSHOT + STATE_DELTA (RFC 6902) over the tree/log; `deltaSince` below the compaction floor throws so consumers re-send a snapshot (M17).
- Semantic-unit staleness: writes/moves/removes inside a shard re-mark the owning `embedText` ancestor stale; move/remove fire index hooks (M17).

*(The three M17 bullets above shipped in 1.0.0 but were missing from this entry — added retroactively.)*
