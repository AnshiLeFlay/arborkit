# Contributing to arborkit

Thanks for your interest. This is a small, focused library — a zero-runtime-dependency
TypeScript core for multi-agent artifact trees. Contributions are welcome; the notes
below keep changes fast to review.

## Getting started

Requires **Node ≥ 20.6** (ESM-only).

```bash
git clone https://github.com/AnshiLeFlay/arborkit.git
cd arborkit
npm install
npm test          # vitest run — the full suite
```

Useful scripts:

| Command             | What it does                                  |
| ------------------- | --------------------------------------------- |
| `npm test`          | Run the test suite once (vitest)              |
| `npm run test:watch`| Watch mode                                    |
| `npm run typecheck` | `tsc --noEmit` — no type errors allowed       |
| `npm run build`     | Bundle with tsup (must succeed)               |
| `npm run docs:api`  | Generate the TypeDoc API reference            |
| `npm run bench`     | Micro-benchmarks (optional, for perf changes) |

## Before you open a PR

CI runs `npm test`, `npm run typecheck`, `npm run build`, and `npm run docs:api`
on Node 20 and 22. Run them locally first — a green PR merges faster:

```bash
npm test && npm run typecheck && npm run build && npm run docs:api
```

Guidelines:

- **Tests first.** Add or update tests for any behavior change; the suite is the
  spec. Bug fixes should come with a test that fails before the fix.
- **Keep it zero-dependency.** The published package ships no runtime dependencies —
  don't add one. Dev-only tooling (`devDependencies`) is fine when justified.
- **Public API changes** (new/renamed exports, changed signatures) need a
  `CHANGELOG.md` entry and a note in the PR description. Follow semver: breaking
  changes are a major bump.
- **Match the surrounding style.** No linter is enforced; mirror the existing code —
  naming, structure, and the doc-comment density already in the file you touch.
- Keep PRs focused on one thing; smaller diffs get reviewed sooner.

## Reporting bugs and requesting features

Open an issue at https://github.com/AnshiLeFlay/arborkit/issues. For bugs, a minimal
reproduction (or a failing test) is the fastest path to a fix.

For **security issues, do not open a public issue** — see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
