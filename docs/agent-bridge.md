# Agent bridge

The agent bridge converts a scoped `Toolset` into provider-neutral tool
definitions and a never-throw executor. Each definition contains an input JSON
Schema (`schema`) and a full `ToolResult` output JSON Schema (`outputSchema`).

## Capability profiles

| Profile | Capabilities |
| --- | --- |
| `reader` | Search, find, describe, get, history, and historical reads. |
| `editor` | Reader tools plus edit, set, insert, and move. |
| `admin` | Every tool, including remove, revert, and atomic batch. |

`include` further narrows a profile. It never adds a capability excluded by the
profile.

For upgrade safety, omitting both options preserves the v1.2 nine-tool surface.
New `insert`/`remove`/`move`/`batch_patch` capabilities require explicit opt-in.

```ts
const definitions = agentToolDefs({
  profile: "editor",
  include: ["search", "get", "edit"],
});
const execute = makeToolExecutor(toolset, {
  profile: "editor",
  include: ["search", "get", "edit"],
});
```

Pass identical surface options to both functions so advertised and executable
tools remain aligned.

## Optimistic concurrency

`get` returns `meta.version`. Pass it as `ifVersion` to a subsequent write. If
another write landed after the read, ArborKit returns `STALE_VERSION` instead of
overwriting the newer value.

```ts
const current = JSON.parse(await execute("get", { path: "/draft/title" }));
const changed = await execute("edit", {
  path: "/draft/title",
  old: current.value.content,
  new: "Reviewed title",
  ifVersion: current.value.meta.version,
});
```

For `insert`, `ifVersion` belongs to the parent container: any sibling insertion
also changes that version.

## Atomic batches

`batch_patch` accepts `edit`, `set_value`, `insert`, `remove`, and `move`
operations. All operations share one transaction.

```ts
await execute("batch_patch", {
  operations: [
    { op: "edit", path: "/draft/title", old: "Draft", new: "Final", ifVersion: 2 },
    { op: "set_value", path: "/draft/status", value: "ready", ifVersion: 1 },
    { op: "insert", path: "/draft/sections", key: "summary", value: "..." },
  ],
});
```

If any operation fails, earlier changes and events are rolled back. Operations
are evaluated against the live result of preceding operations, so stable node IDs
are preferable when a batch moves and then edits the same node through the core
`Toolset.batchPatch` API.

## Guards and approvals

Guards encode deterministic domain policy and can return a custom structured
error. Approval is a boolean sync/async decision, typically backed by a human or
external policy service.

```ts
const execute = makeToolExecutor(toolset, {
  profile: "admin",
  guard: async (name, input) =>
    name === "remove" && input.path === "/protected"
      ? { code: "PROTECTED", message: "protected content cannot be removed" }
      : null,
  approval: async (name) => name !== "remove" || requestHumanApproval(),
});
```

For a batch, ArborKit validates and invokes the hooks once per contained
operation before dispatching anything. One refusal leaves the entire batch
untouched.

Read-only analytics use the same definition and never-throw result contract via
`analyzeToolDefs` and `makeAnalyzeExecutor`. See [Native analysis](native-analysis.md)
for composing both surfaces in one model tool loop.
