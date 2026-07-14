# Native analysis

ArborKit 1.4 adds a deterministic, domain-agnostic analysis layer over the JSON
tree and its existing vectors. It returns measurements and structures, never a
business verdict. Your application decides whether a distance, silhouette score,
cluster, or structural group requires action.

## What is included

- Vector math: dot product, norm, normalization, cosine, Euclidean distance, and centroid.
- Vector analytics: seeded k-means++, silhouette, global-centroid distance,
  k-nearest-neighbour local distance, nearest-centroid classification, and score diffs.
- Structural analytics: canonical JSON hashes, value-independent shape tokens,
  exact Jaccard, and seeded MinHash.
- Graph analytics: cosine k-NN graphs, connected components, directed cycles,
  topological sorting, degree counts, reachability, and orphan sets.
- Seven read-only LLM tools with input/output JSON Schemas and a never-throw executor.

All algorithms are deterministic for the same input and seed. The package keeps
zero runtime dependencies.

## Analyze indexed nodes

```ts
import {
  collectVectors,
  kmeans,
  localOutlierScores,
  silhouette,
} from "arborkit/analyze";

const view = await collectVectors(arbor, {
  under: "/pages",
  type: "page",
  tag: "published",
  freshness: "wait",
});

const clusters = kmeans(view, { k: 3, seed: 1 });
const quality = silhouette(view, clusters.assignments);
const localDistances = localOutlierScores(view, { k: 5 });
```

`freshness: "wait"` drains the current semantic reindex queue before collecting
vectors. `best-effort` reads the vectors already present in the configured
`VectorIndexPort`. `collectVectors` materializes the matching set, so a remote
vector adapter may make this operation expensive.

## Compare subtree structure

Use an exact canonical hash when values must match, or shape tokens when only the
layout matters.

```ts
import { structuralHash, shapeTokens, jaccard } from "arborkit/analyze-struct";

const left = arbor.tree.toJson(leftNodeId);
const right = arbor.tree.toJson(rightNodeId);

const exactHashes = [structuralHash(left), structuralHash(right)];
const shapeSimilarity = jaccard(shapeTokens(left), shapeTokens(right));
```

No threshold is built in. For example, ArborKit does not decide that
`shapeSimilarity < 0.9` means an inconsistent menu.

For a repeated section across different parent documents, the
`structural_groups` tool accepts `relativePath`. Calling it with
`{ under: "/pages", relativePath: "/header/nav" }` compares that selected
subtree inside every direct page child. Its `missing` array reports candidates
that do not contain the selected subtree.

## Give analysis tools to an agent

Analysis definitions use the same provider-neutral contract as the main Agent
Bridge. Every analysis tool is read-only and therefore available under
`reader`, `editor`, and `admin`; `include` can narrow the surface.

```ts
import {
  agentToolDefs,
  makeToolExecutor,
} from "arborkit/agent-tools";
import {
  analyzeToolDefs,
  makeAnalyzeExecutor,
} from "arborkit/analyze-tools";

const stateDefs = agentToolDefs({ profile: "editor" });
const analysisDefs = analyzeToolDefs({ profile: "editor" });
const definitions = [...stateDefs, ...analysisDefs];

const executeState = makeToolExecutor(arbor.toolset({
  owner: "editor",
  readScope: "/pages",
  writeScope: "/pages",
}), { profile: "editor" });
const executeAnalysis = makeAnalyzeExecutor(arbor, {
  profile: "editor",
  readScope: "/pages",
});

const analysisNames = new Set<string>(analysisDefs.map((definition) => definition.name));
const execute = (name: string, input: unknown) =>
  analysisNames.has(name)
    ? executeAnalysis(name, input)
    : executeState(name, input);
```

The analysis executor supports the same result-size cap and an async read-policy
`guard`. It intentionally has no approval callback because it cannot mutate the
artifact. The tools are `cluster`, `outliers`, `local_outliers`, `silhouette`,
`similarity_graph`, `components`, and `structural_groups`.

Set `readScope` whenever an agent should analyze only part of the artifact. An
omitted `under` then defaults to that scope; an explicit path outside it returns
`SCOPE_VIOLATION` before the guard or analysis runs. Profiles control capabilities,
while `readScope` controls data visibility.

## Scale limits

The bundled implementation targets hundreds to low thousands of analyzed nodes.
k-NN graphs and silhouette are O(n²), and the in-memory vector index is
brute-force. Use narrower filters or a custom `VectorIndexPort` when the artifact
is larger. ArborKit currently materializes vector entries before analysis; it
does not claim ANN execution for these analytics.
