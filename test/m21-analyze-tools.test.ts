import { describe, expect, it } from "vitest";
import { createArbor } from "../src/arbor";
import { analyzeToolDefs, makeAnalyzeExecutor } from "../src/analyze-tools";
import { sizeBasedDecision } from "../src/decompose";
import { MockEmbeddingPort } from "../src/embedding-port";

const ALL_NAMES = [
  "cluster",
  "outliers",
  "local_outliers",
  "silhouette",
  "similarity_graph",
  "components",
  "structural_groups",
];

function fixture() {
  return createArbor({
    initial: {
      pages: {
        p1: { nav: ["H", "R"], text: "alpha alpha" },
        p2: { nav: ["H", "R"], text: "alpha beta" },
        p3: { nav: ["H", "R", "X"], text: "omega omega" },
      },
    },
    embedding: new MockEmbeddingPort(),
    decompose: sizeBasedDecision(1),
  });
}

describe("M21 analysis tool definitions", () => {
  it("exposes seven read-only tools with input and output JSON Schema", () => {
    const definitions = analyzeToolDefs({ profile: "reader" });
    expect(definitions.map((definition) => definition.name)).toEqual(ALL_NAMES);
    expect(definitions.every((definition) => definition.schema.type === "object")).toBe(true);
    expect(definitions.every((definition) => "oneOf" in definition.outputSchema!)).toBe(true);
  });

  it("uses profile/include intersection without widening capabilities", () => {
    expect(analyzeToolDefs({ profile: "editor", include: ["cluster", "outliers"] }).map((d) => d.name))
      .toEqual(["cluster", "outliers"]);
    expect(analyzeToolDefs({ profile: "admin", include: [] })).toEqual([]);
  });
});

describe("M21 analysis executor", () => {
  it("runs vector analysis with filters and returns id-addressable assignments", async () => {
    const arbor = fixture();
    await arbor.index!.reindex();
    const execute = makeAnalyzeExecutor(arbor, { profile: "reader" });
    const cluster = JSON.parse(await execute("cluster", {
      k: 2,
      seed: 1,
      under: "/pages",
      freshness: "wait",
    }));
    expect(cluster.ok).toBe(true);
    expect(cluster.value.assignments.length).toBeGreaterThan(0);
    expect(cluster.value.assignments[0]).toEqual(expect.objectContaining({
      id: expect.any(String),
      path: expect.stringMatching(/^\/pages/),
      cluster: expect.any(Number),
    }));

    for (const name of ["outliers", "local_outliers", "silhouette", "similarity_graph", "components"] as const) {
      const input = name === "silhouette" ? { k: 2 } : name === "outliers" ? {} : { k: 2 };
      const output = JSON.parse(await execute(name, input));
      expect(output.ok, `${name}: ${JSON.stringify(output)}`).toBe(true);
      expect(JSON.stringify(output)).not.toMatch(/isOutlier|inconsistent|verdict/i);
    }
  });

  it("groups direct child subtrees by exact canonical hash", async () => {
    const output = JSON.parse(await makeAnalyzeExecutor(fixture())("structural_groups", {
      under: "/pages",
      relativePath: "/nav",
    }));
    expect(output.ok).toBe(true);
    expect(output.value.groups).toHaveLength(2);
    expect(output.value.missing).toEqual([]);
    expect(output.value.groups.map((group: { paths: string[] }) => group.paths).sort((a: string[], b: string[]) => a.length - b.length))
      .toEqual([["/pages/p3"], ["/pages/p1", "/pages/p2"]]);
  });

  it("reports candidates missing the selected relative subtree", async () => {
    const arbor = fixture();
    arbor.mutator.remove({ path: "/pages/p3/nav" });
    const output = JSON.parse(await makeAnalyzeExecutor(arbor)("structural_groups", {
      under: "/pages",
      relativePath: "/nav",
    }));
    expect(output.ok).toBe(true);
    expect(output.value.missing).toEqual(["/pages/p3"]);
  });

  it("enforces readScope before guards or analysis dispatch", async () => {
    const execute = makeAnalyzeExecutor(fixture(), { profile: "reader", readScope: "/pages/p1" });
    const scoped = JSON.parse(await execute("cluster", { k: 1 }));
    expect(scoped.ok).toBe(true);
    expect(scoped.value.assignments.every((item: { path: string }) => item.path.startsWith("/pages/p1"))).toBe(true);

    const escaped = JSON.parse(await execute("structural_groups", { under: "/pages" }));
    expect(escaped).toEqual({
      ok: false,
      error: { code: "SCOPE_VIOLATION", message: "path /pages is outside read scope /pages/p1" },
    });
  });

  it("preflights async guards and never throws for invalid, unknown, or oversized calls", async () => {
    const seen: string[] = [];
    const execute = makeAnalyzeExecutor(fixture(), {
      include: ["cluster"],
      maxResultChars: 30,
      guard: async (name) => {
        seen.push(name);
        return name === "cluster" ? { code: "POLICY", message: "analysis paused" } : null;
      },
    });
    expect(JSON.parse(await execute("cluster", { k: 2 }))).toEqual({
      ok: false,
      error: { code: "POLICY", message: "analysis paused" },
    });
    expect(seen).toEqual(["cluster"]);
    expect(JSON.parse(await execute("outliers", {})).error.code).toBe("UNKNOWN_TOOL");
    expect(JSON.parse(await execute("cluster", { k: 0 })).error.code).toBe("INVALID_INPUT");

    const capped = makeAnalyzeExecutor(fixture(), { include: ["structural_groups"], maxResultChars: 30 });
    expect(JSON.parse(await capped("structural_groups", { under: "/pages" })).error.code).toBe("TOO_LARGE");
  });
});
