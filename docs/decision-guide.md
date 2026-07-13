# Decision guide

## Use ArborKit when

- several agents build or revise one structured JSON artifact;
- agents should see only selected subtrees;
- small edits should not regenerate a large document;
- audit history, diff, revert, and time-travel are product requirements;
- exact navigation and semantic discovery should address the same nodes;
- the application already has an LLM SDK or agent runtime.

Typical artifacts include generated sites, research dossiers, plans, reports,
catalogs, configuration, and structured editorial documents.

## Do not use ArborKit as the primary solution when

- several processes or offline clients must write concurrently;
- you need CRDT convergence or realtime collaborative editing;
- you need a durable workflow scheduler, retries, interrupts, and HITL execution;
- mutually untrusted code will share one process;
- the artifact is primarily relational data rather than one JSON document.

## Alternatives and complements

| Need | Prefer | Relationship to ArborKit |
| --- | --- | --- |
| Durable agent orchestration, threads, interrupts | [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/overview) | Run ArborKit inside graph nodes as the artifact state layer. |
| TypeScript agents, workflows, sandboxes, Studio | [Mastra](https://mastra.ai/docs) | Give a Mastra agent ArborKit-backed custom tools. |
| Offline multi-writer JSON with automatic merge | [Automerge](https://automerge.org/) | Choose instead of the current single-writer backend. |
| Realtime editor collaboration and bindings | [Yjs](https://docs.yjs.dev/) | Choose for shared text/editor state; ArborKit is agent-artifact oriented. |
| Managed collaboration, presence, and rooms | [Liveblocks](https://liveblocks.io/docs) | Choose when a hosted realtime collaboration service is desired. |

ArborKit deliberately does not choose models, schedule agents, or own the tool
call loop. Its boundary is the shared artifact and the safe operations over it.

## Current operating envelope

- One artifact lives in one process with one writer.
- File persistence is a snapshot/journal target, not a shared database.
- Path scopes constrain tool calls but are not a code isolation boundary.
- The bundled vector index uses brute-force cosine search and targets roughly
  ten thousand vectors; larger deployments should provide another
  `VectorIndexPort`.
- History retention and embedding freshness policies are caller-managed.

See the [production checklist](production-checklist.md) before adopting ArborKit
for a production workload.

