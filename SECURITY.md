# Security Policy

## Supported versions

`arborkit` follows semantic versioning. Security fixes land on the latest
published minor; there is no long-term-support branch for older releases.
Upgrade to the newest `1.x` to receive fixes.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Report privately to **d.a.pominov@gmail.com** (or via GitHub's
[private vulnerability reporting](https://github.com/AnshiLeFlay/arborkit/security/advisories/new)).
Include:

- the affected version(s),
- a description of the issue and its impact,
- a minimal reproduction if you have one.

You'll get an acknowledgement as soon as possible. Once a fix is ready it
ships as a patch release and the advisory is published with credit to the
reporter (unless you'd rather stay anonymous).

## Scope

`arborkit` is a zero-runtime-dependency library that operates on in-memory
JSON trees and persists to storage you provide. It does not open network
connections, spawn processes, or read/write files on its own — the
`FileStorage` adapter writes only to paths the caller passes in. Reports
most relevant to this library:

- prototype-pollution or unsafe property access during decompose / mutate /
  JSON-Pointer resolution,
- ways a crafted artifact, event log, or delta journal could corrupt state
  or cause unbounded resource use on restore/replay.

Out of scope: vulnerabilities in your own `EmbeddingPort` /
`VectorIndexPort` / storage implementations, and in dev-only dependencies
(they are not shipped in the published package).
