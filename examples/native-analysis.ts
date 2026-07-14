/**
 * Verdict-free native analysis plus a read -> analyze -> fix loop.
 *
 * Run with: npm run example:analysis
 */
import { createArbor } from "../src/arbor";
import { makeAnalyzeExecutor } from "../src/analyze-tools";
import { sizeBasedDecision } from "../src/decompose";
import { MockEmbeddingPort } from "../src/embedding-port";

const commonNav = ["Home", "Docs"];
const arbor = createArbor({
  initial: {
    pages: {
      guide: { nav: commonNav, body: "ArborKit shared workspace" },
      reference: { nav: commonNav, body: "ArborKit API reference" },
      drifted: { nav: ["Home", "Docs", "Casino"], body: "casino bonus offer" },
    },
  },
  decompose: sizeBasedDecision(1),
  embedding: new MockEmbeddingPort(),
});

await arbor.index!.reindex();
const analyze = makeAnalyzeExecutor(arbor, { profile: "reader", readScope: "/pages" });

const local = JSON.parse(await analyze("local_outliers", {
  under: "/pages",
  k: 2,
  topN: 5,
  freshness: "wait",
}));
if (!local.ok) throw new Error(JSON.stringify(local.error));
console.log("local distance scores:", JSON.stringify(local.value, null, 2));

const before = JSON.parse(await analyze("structural_groups", {
  under: "/pages",
  relativePath: "/nav",
}));
if (!before.ok) throw new Error(JSON.stringify(before.error));
console.log("structural groups before:", before.value.groups.length);

// The application interprets the metrics and chooses a fix. ArborKit itself does
// not label a score as bad or a subtree as inconsistent.
const editor = arbor.toolset({ owner: "reviewer", readScope: "/pages", writeScope: "/pages" });
const fixed = await editor.patch({ path: "/pages/drifted/nav" }, { op: "set", value: commonNav });
if (!fixed.ok) throw new Error(fixed.error.message);

const after = JSON.parse(await analyze("structural_groups", {
  under: "/pages",
  relativePath: "/nav",
}));
if (!after.ok) throw new Error(JSON.stringify(after.error));
console.log("structural groups after:", after.value.groups.length);

if (before.value.groups.length !== 2 || after.value.groups.length !== 1) {
  throw new Error("analysis example did not converge to one exact structural group");
}
