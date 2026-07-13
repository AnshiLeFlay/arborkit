/**
 * A multi-agent research artifact: two researchers add findings to one shared
 * tree, while a synthesizer can only write the final synthesis.
 *
 * Run with: npm run example:research
 */
import { createArbor } from "../src/arbor";
import { sizeBasedDecision } from "../src/decompose";

function expectOk<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const arbor = createArbor({
  initial: {
    research: {
      question: "How should an agent team maintain one trustworthy working artifact?",
      findings: {},
      synthesis: "",
    },
  },
  decompose: sizeBasedDecision(1),
});

const researcherA = arbor.toolset({ owner: "researcher:a", writeScope: "/research/findings" });
const researcherB = arbor.toolset({ owner: "researcher:b", writeScope: "/research/findings" });
const synthesizer = arbor.toolset({
  owner: "synthesizer",
  readScope: "/research",
  writeScope: "/research/synthesis",
});

expectOk(
  await researcherA.patch(
    { path: "/research/findings" },
    {
      op: "insert",
      key: "scoped-tools",
      value: { claim: "Give each agent the narrowest writable subtree.", confidence: 0.94 },
    },
  ),
);
expectOk(
  await researcherB.patch(
    { path: "/research/findings" },
    {
      op: "insert",
      key: "audit-log",
      value: { claim: "Keep mutations append-only so decisions can be inspected and reverted.", confidence: 0.91 },
    },
  ),
);

const findings = expectOk(await synthesizer.get({ path: "/research/findings" }));
const beforeSynthesis = arbor.log.length();
expectOk(
  await synthesizer.patch(
    { path: "/research/synthesis" },
    { op: "set", value: "Use scoped writes plus an append-only audit trail." },
  ),
);

const refused = await synthesizer.patch(
  { path: "/research/question" },
  { op: "set", value: "A synthesizer must not rewrite the research question." },
);
if (refused.ok || refused.error.code !== "SCOPE_VIOLATION") {
  throw new Error("expected a structured scope violation");
}

// Omitting `ref` returns every event visible inside the toolset's read scope.
const history = expectOk(await synthesizer.history());
const past = expectOk(await synthesizer.getAt({ path: "/research/synthesis" }, beforeSynthesis));

console.log("findings:", JSON.stringify(findings.content, null, 2));
console.log("synthesis before the write:", JSON.stringify(past));
console.log("audit actors:", history.map((event) => event.actor));
console.log("final artifact:", JSON.stringify(arbor.tree.toJson(), null, 2));
