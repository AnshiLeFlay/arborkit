import { describe, expect, it } from "vitest";
import { Addressing } from "../src/addressing";
import {
  AGENT_TOOL_PROFILES,
  agentToolDefs,
  makeToolExecutor,
  type AgentToolName,
  type ToolApproval,
  type ToolGuard,
} from "../src/agent-tools";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { FixedClock } from "../src/clock";
import { sizeBasedDecision } from "../src/decompose";
import { EventLog } from "../src/event-log";
import { MockEmbeddingPort } from "../src/embedding-port";
import { SeqIdGen } from "../src/ids";
import { Mutator } from "../src/mutator";
import { SemanticIndex } from "../src/semantic-index";
import { makeToolset, type ToolResult } from "../src/toolset";
import type { Json } from "../src/types";
import { MemoryVectorIndex } from "../src/vector-index-port";

const ALL_NAMES: AgentToolName[] = [
  "search",
  "find",
  "describe",
  "get",
  "edit",
  "set_value",
  "insert",
  "remove",
  "move",
  "batch_patch",
  "history",
  "get_at",
  "revert",
];

function parse(json: string): ToolResult<any> {
  return JSON.parse(json) as ToolResult<any>;
}

function setup(initial: Json = { pages: { home: { title: "Home", body: "Hello" }, archive: {} } }) {
  const clock = new FixedClock(0);
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson(initial, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock });
  const tools = makeToolset({ tree, addressing, log, mutator }, { owner: "agent", writeScope: "/pages" });
  return { tree, addressing, log, mutator, tools };
}

describe("M20 agent bridge definitions and profiles", () => {
  it("publishes all core mutations plus batch, with input and output schemas", () => {
    const defs = agentToolDefs({ profile: "admin" });
    expect(defs.map((def) => def.name)).toEqual(ALL_NAMES);
    for (const def of defs) {
      expect(def.schema["type"]).toBe("object");
      expect(def.outputSchema!["oneOf"]).toBeInstanceOf(Array);
    }

    for (const name of ["edit", "set_value", "insert", "remove", "move"] as const) {
      const properties = agentToolDefs({ profile: "admin" }).find((def) => def.name === name)!.schema["properties"] as Record<
        string,
        unknown
      >;
      expect(properties).toHaveProperty("ifVersion");
    }
  });

  it("reader/editor/admin profiles expose increasingly powerful canonical subsets", () => {
    expect(agentToolDefs({ profile: "reader" }).map((def) => def.name)).toEqual(AGENT_TOOL_PROFILES.reader);
    expect(agentToolDefs({ profile: "editor" }).map((def) => def.name)).toEqual(AGENT_TOOL_PROFILES.editor);
    expect(agentToolDefs({ profile: "admin" }).map((def) => def.name)).toEqual(ALL_NAMES);
    expect(AGENT_TOOL_PROFILES.reader).not.toContain("edit");
    expect(AGENT_TOOL_PROFILES.editor).toContain("edit");
    expect(AGENT_TOOL_PROFILES.editor).not.toContain("remove");
  });

  it("keeps new destructive tools opt-in for v1.2 upgrade safety", async () => {
    const { tree, tools } = setup();
    expect(agentToolDefs().map((def) => def.name)).not.toContain("remove");
    const defaultExecute = makeToolExecutor(tools);
    const refused = parse(await defaultExecute("remove", { path: "/pages/home/body" }));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("UNKNOWN_TOOL");
    expect((tree.toJson() as any).pages.home.body).toBe("Hello");

    const explicitExecute = makeToolExecutor(tools, { include: ["remove"] });
    expect(parse(await explicitExecute("remove", { path: "/pages/home/body" })).ok).toBe(true);
  });

  it("include intersects the selected profile for definitions and executor", async () => {
    const { tools } = setup();
    expect(agentToolDefs({ profile: "reader", include: ["get", "edit"] }).map((def) => def.name)).toEqual(["get"]);
    const execute = makeToolExecutor(tools, { profile: "reader", include: ["get", "edit"] });
    expect(parse(await execute("get", { path: "/pages/home" })).ok).toBe(true);
    const denied = parse(await execute("edit", { path: "/pages/home/title", old: "Home", new: "X" }));
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("UNKNOWN_TOOL");
  });
});

describe("M20 agent bridge mutations and optimistic versions", () => {
  it("dispatches insert, move, and remove", async () => {
    const { tree, tools } = setup();
    const execute = makeToolExecutor(tools, { profile: "admin" });
    expect(parse(await execute("insert", { path: "/pages", key: "draft", value: { title: "Draft" } })).ok).toBe(true);
    expect(
      parse(await execute("move", { path: "/pages/draft", toPath: "/pages/archive", key: "draft" })).ok,
    ).toBe(true);
    expect(parse(await execute("remove", { path: "/pages/archive/draft" })).ok).toBe(true);
    expect(tree.toJson()).toEqual({ pages: { home: { title: "Home", body: "Hello" }, archive: {} } });
  });

  it("passes ifVersion through and returns STALE_VERSION without changing the tree", async () => {
    const { tree, addressing, tools } = setup();
    const execute = makeToolExecutor(tools, { profile: "admin" });
    const version = addressing.byPath("/pages/home/title")!.meta.version;
    expect(
      parse(await execute("set_value", { path: "/pages/home/title", value: "Fresh", ifVersion: version })).ok,
    ).toBe(true);
    const stale = parse(
      await execute("edit", { path: "/pages/home/title", old: "Fresh", new: "Lost", ifVersion: version }),
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("STALE_VERSION");
    expect((tree.toJson() as any).pages.home.title).toBe("Fresh");
  });

  it("forwards stale versions for insert, remove, and move", async () => {
    const cases: Array<{ name: AgentToolName; input: Record<string, unknown>; versionPath: string }> = [
      { name: "insert", input: { path: "/pages", key: "x", value: 1 }, versionPath: "/pages" },
      { name: "remove", input: { path: "/pages/home/body" }, versionPath: "/pages/home/body" },
      {
        name: "move",
        input: { path: "/pages/home/body", toPath: "/pages/archive", key: "body" },
        versionPath: "/pages/home/body",
      },
    ];
    for (const testCase of cases) {
      const { tree, addressing, tools } = setup();
      const before = structuredClone(tree.toJson());
      const staleVersion = addressing.byPath(testCase.versionPath)!.meta.version + 1;
      const execute = makeToolExecutor(tools, { profile: "admin" });
      const result = parse(await execute(testCase.name, { ...testCase.input, ifVersion: staleVersion }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("STALE_VERSION");
      expect(tree.toJson()).toEqual(before);
    }
  });

  it("batch_patch commits all operations and rolls all of them back on failure", async () => {
    const { tree, log, tools } = setup();
    const execute = makeToolExecutor(tools, { profile: "admin" });
    const ok = parse(
      await execute("batch_patch", {
        operations: [
          { op: "set_value", path: "/pages/home/title", value: "Reviewed" },
          { op: "edit", path: "/pages/home/body", old: "Hello", new: "Hello world" },
        ],
      }),
    );
    expect(ok.ok).toBe(true);
    const beforeFailedBatch = structuredClone(tree.toJson());
    const logLength = log.length();
    const failed = parse(
      await execute("batch_patch", {
        operations: [
          { op: "set_value", path: "/pages/home/title", value: "Must roll back" },
          { op: "remove", path: "" },
        ],
      }),
    );
    expect(failed.ok).toBe(false);
    expect(tree.toJson()).toEqual(beforeFailedBatch);
    expect(log.length()).toBe(logLength);
  });
});

describe("M20 agent bridge search filters", () => {
  it("passes under/type/tag/freshness to semantic search", async () => {
    const clock = new FixedClock(0);
    const deps: TreeDeps = { idGen: new SeqIdGen(), clock, decision: sizeBasedDecision(1) };
    const tree = ArtifactTree.fromJson({ pages: {}, private: {} }, deps);
    const addressing = new Addressing(tree);
    const log = new EventLog();
    const index = new SemanticIndex(tree, addressing, new MockEmbeddingPort(), new MemoryVectorIndex());
    const mutator = new Mutator(tree, addressing, log, { clock, ...index.hooks() });
    mutator.insert({ path: "/pages" }, "offer", "casino bonus", { type: "Page", tags: ["public"] });
    mutator.insert({ path: "/private" }, "offer", "casino bonus", { type: "Page", tags: ["private"] });
    const tools = makeToolset({ tree, addressing, log, mutator, index }, { readScope: "/pages" });
    const execute = makeToolExecutor(tools);

    const result = parse(
      await execute("search", {
        query: "casino bonus",
        k: 5,
        under: "/pages",
        type: "Page",
        tag: "public",
        freshness: "wait",
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.results.map((hit: any) => hit.path)).toEqual(["/pages/offer"]);
  });
});

describe("M20 surface narrowing is batch-proof", () => {
  it("batch_patch cannot widen a narrowed include surface", async () => {
    const { tree, tools } = setup();
    const execute = makeToolExecutor(tools, { include: ["get", "edit", "batch_patch"] });

    const direct = parse(await execute("remove", { path: "/pages/home/body" }));
    expect(direct.ok).toBe(false);
    if (!direct.ok) expect(direct.error.code).toBe("UNKNOWN_TOOL");

    const viaBatch = parse(
      await execute("batch_patch", { operations: [{ op: "remove", path: "/pages/home/body" }] }),
    );
    expect(viaBatch.ok).toBe(false);
    if (!viaBatch.ok) expect(viaBatch.error.code).toBe("UNKNOWN_TOOL");
    expect((tree.toJson() as any).pages.home.body).toBe("Hello");

    const allowedBatch = parse(
      await execute("batch_patch", {
        operations: [{ op: "edit", path: "/pages/home/body", old: "Hello", new: "Hi" }],
      }),
    );
    expect(allowedBatch.ok).toBe(true);
    expect((tree.toJson() as any).pages.home.body).toBe("Hi");
  });

  it("refuses a mixed batch atomically when one operation is outside the surface", async () => {
    const { tree, log, tools } = setup();
    const execute = makeToolExecutor(tools, { include: ["set_value", "batch_patch"] });
    const before = structuredClone(tree.toJson());
    const result = parse(
      await execute("batch_patch", {
        operations: [
          { op: "set_value", path: "/pages/home/title", value: "No commit" },
          { op: "remove", path: "/pages/home/body" },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNKNOWN_TOOL");
    expect(tree.toJson()).toEqual(before);
    expect(log.length()).toBe(0);
  });
});

describe("M20 shared schema leaves are deeply frozen", () => {
  it("mutation attempts throw and cannot contaminate future defs", () => {
    const reference = structuredClone(agentToolDefs({ profile: "admin" }));
    const defs = agentToolDefs({ profile: "admin" });

    const insertKey = (defs.find((def) => def.name === "insert")!.schema["properties"] as any).key;
    expect(() => insertKey.oneOf.push({ type: "boolean" })).toThrow(TypeError);

    const searchFreshness = (defs.find((def) => def.name === "search")!.schema["properties"] as any).freshness;
    expect(() => searchFreshness.enum.push("stale-ok")).toThrow(TypeError);

    const editOk = (defs.find((def) => def.name === "edit")!.outputSchema!["oneOf"] as any)[0];
    const patchResult = editOk.properties.value;
    expect(() => {
      patchResult.properties.extra = { type: "string" };
    }).toThrow(TypeError);
    expect(() => patchResult.required.push("extra")).toThrow(TypeError);

    expect(agentToolDefs({ profile: "admin" })).toEqual(reference);
  });
});

describe("M20 result cap never masks committed writes", () => {
  it("caps oversized reads but returns the full result for an oversized committed batch", async () => {
    const { tree, tools } = setup();
    const execute = makeToolExecutor(tools, { profile: "admin", maxResultChars: 60 });

    const read = parse(await execute("get", { path: "/pages/home" }));
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.code).toBe("TOO_LARGE");

    const write = parse(
      await execute("batch_patch", {
        operations: [
          { op: "set_value", path: "/pages/home/title", value: "First" },
          { op: "set_value", path: "/pages/home/body", value: "Second" },
          { op: "set_value", path: "/pages/home/title", value: "Third" },
        ],
      }),
    );
    expect(write.ok).toBe(true);
    if (write.ok) expect(write.value).toHaveLength(3);
    expect((tree.toJson() as any).pages.home.title).toBe("Third");
  });
});

describe("M20 operation guards and approvals", () => {
  it("guard sees the same input shape for batch operations as for standalone calls", async () => {
    const { tools } = setup();
    const inputs: Array<Record<string, unknown>> = [];
    const guard: ToolGuard = (_name, input) => {
      inputs.push(input);
      return null;
    };
    const execute = makeToolExecutor(tools, { profile: "admin", guard });
    await execute("edit", { path: "/pages/home/body", old: "Hello", new: "Hi" });
    await execute("batch_patch", {
      operations: [{ op: "edit", path: "/pages/home/body", old: "Hi", new: "Hello" }],
    });
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).not.toHaveProperty("op");
    expect(Object.keys(inputs[1]!).sort()).toEqual(Object.keys(inputs[0]!).sort());
  });

  it("denies the whole batch before any write when one operation fails approval", async () => {
    const { tree, log, tools } = setup();
    const asked: AgentToolName[] = [];
    const approval: ToolApproval = (name) => {
      asked.push(name);
      return name !== "remove";
    };
    const execute = makeToolExecutor(tools, { profile: "admin", approval });
    const before = structuredClone(tree.toJson());
    const result = parse(
      await execute("batch_patch", {
        operations: [
          { op: "set_value", path: "/pages/home/title", value: "No commit" },
          { op: "remove", path: "/pages/home/body" },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("APPROVAL_DENIED");
    expect(asked).toEqual(["set_value", "remove"]);
    expect(tree.toJson()).toEqual(before);
    expect(log.length()).toBe(0);
  });

  it("checks every batch operation before dispatch and leaves the batch untouched on refusal", async () => {
    const { tree, log, tools } = setup();
    const seen: AgentToolName[] = [];
    const guard: ToolGuard = async (name) => {
      seen.push(name);
      return name === "remove" ? { code: "DELETE_BLOCKED", message: "deletes require a separate workflow" } : null;
    };
    const execute = makeToolExecutor(tools, { profile: "admin", guard });
    const before = structuredClone(tree.toJson());
    const result = parse(
      await execute("batch_patch", {
        operations: [
          { op: "set_value", path: "/pages/home/title", value: "No commit" },
          { op: "remove", path: "/pages/home/body" },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("DELETE_BLOCKED");
    expect(seen).toEqual(["set_value", "remove"]);
    expect(tree.toJson()).toEqual(before);
    expect(log.length()).toBe(0);
  });

  it("supports asynchronous approval callbacks and denies before mutation", async () => {
    const { tree, tools } = setup();
    const approval: ToolApproval = async (name) => name !== "remove";
    const execute = makeToolExecutor(tools, { profile: "admin", approval });
    const result = parse(await execute("remove", { path: "/pages/home/body" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("APPROVAL_DENIED");
    expect((tree.toJson() as any).pages.home.body).toBe("Hello");
  });
});
