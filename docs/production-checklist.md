# Production checklist

ArborKit v1 is an embedded single-process core. Complete this checklist before
putting an artifact on a production path.

## State ownership

- [ ] Exactly one process writes an artifact.
- [ ] No two processes point `FileStorage` or `FileDeltaStorage` at the same files.
- [ ] The application serializes concurrent write requests.
- [ ] Every agent/toolset has a stable `owner` for audit events.
- [ ] Writes which depend on a prior read pass the returned `meta.version` as `ifVersion`.
- [ ] Agent profiles expose only the capabilities required by the task.

The ready-made bridge exposes every core mutation. The conservative `editor`
profile omits `remove`, `revert`, and unrestricted `batch_patch`; use `admin` or a
custom `include` set only when those capabilities are intentional.

## Scopes and trust

- [ ] `readScope` and `writeScope` are as narrow as the agent's task permits.
- [ ] Dangerous writes use a domain `guard` or an application approval step.
- [ ] Batch guards/approvals are tested to reject before the first mutation.
- [ ] Mutually untrusted code runs in separate processes or sandboxes.
- [ ] Tool results and errors are treated as untrusted model-visible data.

Scopes constrain ArborKit tool calls. They are not authorization for arbitrary
code that can access the tree or `Mutator` directly.

## Persistence and recovery

- [ ] A checkpoint cadence is defined and tested.
- [ ] A `keepLast` policy bounds event-log growth, or unbounded history is intentional.
- [ ] Restore is exercised against a copy of real artifacts.
- [ ] Registry and decomposition configuration are versioned with the application.
- [ ] Artifact files are backed up outside the live checkpoint/journal paths.
- [ ] Recovery behavior for a torn journal and corrupt checkpoint is monitored.

## Semantic index

- [ ] Reindexing has an explicit trigger and retry policy.
- [ ] The application observes `staleCount` and decides when fresh search is required.
- [ ] Embedding model and vector dimensions stay compatible across restore.
- [ ] A DB/ANN-backed `VectorIndexPort` replaces the memory index above the tested scale.

## Limits and observability

- [ ] Maximum artifact, subtree read, tool-result, and event-log sizes are defined.
- [ ] Tool failures, stale-version errors, checkpoints, restores, and index lag are logged.
- [ ] Benchmarks represent the expected node count and mutation pattern.
- [ ] Node.js and ArborKit versions are pinned and upgrades run restore tests.

## Release gate

```bash
npm test
npm run typecheck
npm run build
npm run example:all
npm run docs:api
```
