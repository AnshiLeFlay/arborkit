# Examples

All examples run against the source tree with `tsx`; no model API key is needed.

| Command | Scenario | What it demonstrates |
| --- | --- | --- |
| `npm run example:content` | A generated content site | Typed semantic units, scoped writers, search, persistence, restore, and time-travel. |
| `npm run example:research` | A shared research dossier | Multiple writers, a separately scoped synthesizer, structured scope failures, and audit history. |
| `npm run example:bridge` | An LLM tool-call loop | Allowlisted definitions/executor, LangChain-compatible definitions, Anthropic mapping, and JSON tool results. |

Run the complete smoke sequence with:

```bash
npm run example:all
```

The examples intentionally use deterministic local/mock behavior where possible.
Production applications should provide their own embedding, vector, and storage
ports and should follow the [production checklist](../docs/production-checklist.md).

