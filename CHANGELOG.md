# Changelog

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
