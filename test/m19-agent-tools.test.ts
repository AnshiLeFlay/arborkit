import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { makeToolset, type Toolset, type ToolResult } from "../src/toolset";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";
import type { Json } from "../src/types";
import {
  agentToolDefs,
  makeToolExecutor,
  DEFAULT_MAX_RESULT_CHARS,
  type AgentToolName,
  type ToolGuard,
} from "../src/agent-tools";

const ALL_NAMES: AgentToolName[] = [
  "search",
  "find",
  "describe",
  "get",
  "edit",
  "set_value",
  "history",
  "get_at",
  "revert",
];

function setup(initial: Json = { pages: { home: { title: "Home", html: "<p>Bonus: 2000 PLN</p>" } } }) {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson(initial, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0) });
  const ts = makeToolset({ tree, addressing, log, mutator }, { writeScope: "/pages" });
  return { tree, addressing, log, mutator, ts };
}

function parse(s: string): ToolResult<any> {
  return JSON.parse(s) as ToolResult<any>;
}

describe("M19 agent-tools — tool defs", () => {
  it("agentToolDefs() returns the 9 defs with valid plain-object JSON Schemas", () => {
    const defs = agentToolDefs();
    expect(defs.map((d) => d.name)).toEqual(ALL_NAMES);
    for (const d of defs) {
      expect(typeof d.name).toBe("string");
      expect(typeof d.description).toBe("string");
      expect(d.description.length).toBeGreaterThan(0);
      expect(d.schema).toBeTypeOf("object");
      expect(d.schema["type"]).toBe("object");
      const properties = d.schema["properties"] as Record<string, unknown>;
      expect(properties).toBeTypeOf("object");
      const required = d.schema["required"] as string[];
      expect(Array.isArray(required)).toBe(true);
      // required lists only keys that exist in properties
      for (const r of required) expect(Object.keys(properties)).toContain(r);
    }
  });

  it("agentToolDefs({include}) filters to exactly the requested tools", () => {
    const defs = agentToolDefs({ include: ["get", "edit"] });
    expect(defs.map((d) => d.name)).toEqual(["get", "edit"]);
  });
});

describe("M19 agent-tools — executor happy paths", () => {
  it("get / edit / get_at / revert round-trip over a real toolset; every result is a valid ToolResult JSON string", async () => {
    const s = setup();
    const exec = makeToolExecutor(s.ts);

    const got = await exec("get", { path: "/pages/home/html" });
    const gotR = parse(got);
    expect(gotR.ok).toBe(true);
    expect(got).toContain("2000 PLN");

    const v = s.log.length(); // pre-edit version
    const edited = await exec("edit", { path: "/pages/home/html", old: "2000 PLN", new: "3000 PLN" });
    const editedR = parse(edited);
    expect(editedR.ok).toBe(true);
    expect((s.tree.toJson() as any).pages.home.html).toBe("<p>Bonus: 3000 PLN</p>");

    const past = await exec("get_at", { path: "/pages/home/html", version: v });
    const pastR = parse(past);
    expect(pastR.ok).toBe(true);
    if (pastR.ok) expect(pastR.value).toEqual({ value: "<p>Bonus: 2000 PLN</p>", existed: true });

    const reverted = await exec("revert", { path: "/pages/home/html", version: v });
    const revertedR = parse(reverted);
    expect(revertedR.ok).toBe(true);
    expect((s.tree.toJson() as any).pages.home.html).toBe("<p>Bonus: 2000 PLN</p>");

    for (const r of [gotR, editedR, pastR, revertedR]) {
      expect(typeof r).toBe("object");
      expect("ok" in r).toBe(true);
    }
  });

  it("describe / find / history / set_value dispatch onto the toolset", async () => {
    const s = setup();
    const exec = makeToolExecutor(s.ts);

    const described = parse(await exec("describe", { path: "/pages/home" }));
    expect(described.ok).toBe(true);
    if (described.ok) expect(described.value.children.length).toBe(2);

    const found = parse(await exec("find", { pathPattern: "/pages/*/title" }));
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.value.hits.map((h: any) => h.path)).toEqual(["/pages/home/title"]);

    const setr = parse(await exec("set_value", { path: "/pages/home/title", value: "New Home" }));
    expect(setr.ok).toBe(true);
    expect((s.tree.toJson() as any).pages.home.title).toBe("New Home");

    const hist = parse(await exec("history", { path: "/pages/home/title", limit: 5 }));
    expect(hist.ok).toBe(true);
    if (hist.ok) {
      expect(hist.value.length).toBe(1);
      expect(hist.value[0].after).toBe("New Home");
    }
  });
});

describe("M19 agent-tools — error passthrough", () => {
  it("ambiguous edit returns the toolset's INVALID_OP with the occurrence count; nothing thrown", async () => {
    const s = setup();
    const exec = makeToolExecutor(s.ts);
    await exec("set_value", { path: "/pages/home/html", value: "<p>2000 PLN and 2000 PLN</p>" });
    const r = await exec("edit", { path: "/pages/home/html", old: "2000 PLN", new: "3000 PLN" });
    expect(r).toContain("INVALID_OP");
    expect(r).toContain("2 times");
    const parsed = parse(r);
    expect(parsed.ok).toBe(false);
  });
});

describe("M19 agent-tools — guard hook", () => {
  it("guard refusal short-circuits with the guard's own code/message; toolset NOT called", async () => {
    const s = setup();
    const guard: ToolGuard = (toolName, input) =>
      toolName === "edit" && typeof input["new"] === "string" && (input["new"] as string).includes("FORBIDDEN")
        ? { code: "GUARD_REFUSED", message: "forbidden content in replacement" }
        : null;
    const exec = makeToolExecutor(s.ts, { guard });

    const before = parse(await exec("get", { path: "/pages/home/html" }));
    const r = parse(await exec("edit", { path: "/pages/home/html", old: "2000 PLN", new: "FORBIDDEN 3000" }));
    expect(r).toEqual({ ok: false, error: { code: "GUARD_REFUSED", message: "forbidden content in replacement" } });
    const after = parse(await exec("get", { path: "/pages/home/html" }));
    if (before.ok && after.ok) {
      expect(after.value.content).toBe(before.value.content);
      expect(after.value.meta.version).toBe(before.value.meta.version);
    } else {
      expect.unreachable("get should succeed");
    }
  });

  it("guard returning null lets the call through", async () => {
    const s = setup();
    const guard: ToolGuard = () => null;
    const exec = makeToolExecutor(s.ts, { guard });
    const r = parse(await exec("edit", { path: "/pages/home/html", old: "2000 PLN", new: "3000 PLN" }));
    expect(r.ok).toBe(true);
    expect((s.tree.toJson() as any).pages.home.html).toBe("<p>Bonus: 3000 PLN</p>");
  });

  it("guard is not invoked on UNKNOWN_TOOL or INVALID_INPUT (call-count spy)", async () => {
    const s = setup();
    let calls = 0;
    const guard: ToolGuard = () => {
      calls++;
      return null;
    };
    const exec = makeToolExecutor(s.ts, { guard });
    await exec("frobnicate", {});
    await exec("edit", { path: "/pages/home/html" }); // missing old/new → INVALID_INPUT
    expect(calls).toBe(0);
    await exec("get", { path: "/pages/home/html" }); // valid → guard consulted
    expect(calls).toBe(1);
  });
});

describe("M19 agent-tools — TOO_LARGE cap", () => {
  it("ok results over maxResultChars are replaced with an actionable TOO_LARGE error", async () => {
    const s = setup();
    const exec = makeToolExecutor(s.ts, { maxResultChars: 50 });
    const r = await exec("get", { path: "/pages/home" });
    const parsed = parse(r);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("TOO_LARGE");
      expect(parsed.error.message).toContain("narrow");
      expect(parsed.error.message).toContain("maxDepth");
    }
  });

  it("error results pass through uncapped (scope violation readable with cap 10)", async () => {
    const s = setup({ pages: { home: { title: "Home" } }, other: "secret" });
    const scoped = makeToolset(
      { tree: s.tree, addressing: s.addressing, log: s.log, mutator: s.mutator },
      { readScope: "/pages" },
    );
    const exec = makeToolExecutor(scoped, { maxResultChars: 10 });
    const r = await exec("get", { path: "/other" });
    expect(r.length).toBeGreaterThan(10);
    const parsed = parse(r);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("SCOPE_VIOLATION");
      expect(parsed.error.message.length).toBeGreaterThan(0);
    }
  });

  it("default cap constant is 20_000", () => {
    expect(DEFAULT_MAX_RESULT_CHARS).toBe(20_000);
  });
});

describe("M19 agent-tools — UNKNOWN_TOOL and INVALID_INPUT", () => {
  it("unknown tool name → UNKNOWN_TOOL listing the available names", async () => {
    const s = setup();
    const exec = makeToolExecutor(s.ts);
    const parsed = parse(await exec("frobnicate", {}));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("UNKNOWN_TOOL");
      expect(parsed.error.message).toContain("frobnicate");
      for (const name of ALL_NAMES) expect(parsed.error.message).toContain(name);
    }
  });

  it("missing required field → INVALID_INPUT naming the field", async () => {
    const s = setup();
    const exec = makeToolExecutor(s.ts);
    const parsed = parse(await exec("edit", { path: "/pages/home/html", new: "x" }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("INVALID_INPUT");
      expect(parsed.error.message).toContain("old");
    }
  });

  it("wrong-typed field → INVALID_INPUT naming the field", async () => {
    const s = setup();
    const exec = makeToolExecutor(s.ts);
    const parsed = parse(await exec("get_at", { path: "/pages/home/html", version: "5" }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("INVALID_INPUT");
      expect(parsed.error.message).toContain("version");
    }
  });

  it("non-object input → INVALID_INPUT", async () => {
    const s = setup();
    const exec = makeToolExecutor(s.ts);
    for (const bad of [null, "str", 42, [1, 2]]) {
      const parsed = parse(await exec("get", bad));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.code).toBe("INVALID_INPUT");
    }
  });
});

describe("M19 agent-tools — EXECUTOR_ERROR never throws", () => {
  it("a toolset method that throws a non-Error is serialized as EXECUTOR_ERROR", async () => {
    const stub = {
      get: () => {
        throw null;
      },
    } as unknown as Toolset;
    const exec = makeToolExecutor(stub);
    const parsed = parse(await exec("get", { path: "/x" }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("EXECUTOR_ERROR");
      expect(parsed.error.message).toBe("null");
    }
  });

  it("a toolset method that throws an Error is serialized with its message", async () => {
    const stub = {
      get: () => {
        throw new Error("boom");
      },
    } as unknown as Toolset;
    const exec = makeToolExecutor(stub);
    const parsed = parse(await exec("get", { path: "/x" }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("EXECUTOR_ERROR");
      expect(parsed.error.message).toBe("boom");
    }
  });
});

describe("M19 agent-tools — review follow-ups", () => {
  it("a guard returning undefined (plain-JS allow path) allows the call", async () => {
    const { ts } = setup();
    // deliberately violates the ToolGuard return type the way untyped JS would
    const guard = (() => undefined) as unknown as ToolGuard;
    const exec = makeToolExecutor(ts, { guard });
    const parsed = parse(await exec("get", { path: "/pages/home/title" }));
    expect(parsed.ok).toBe(true);
  });

  it("a malformed truthy guard return is normalized to a well-formed GUARD_REFUSED", async () => {
    const { ts, tree } = setup();
    const before = JSON.stringify(tree.toJson());
    const guard = (() => "nope") as unknown as ToolGuard;
    const exec = makeToolExecutor(ts, { guard });
    const parsed = parse(await exec("edit", { path: "/pages/home/title", old: "Home", new: "X" }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("GUARD_REFUSED");
      expect(parsed.error.message).toBe("nope");
    }
    expect(JSON.stringify(tree.toJson())).toBe(before); // toolset not called
  });

  it("search dispatches (query, {k}) through a real semantic index", async () => {
    const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
    const tree = ArtifactTree.fromJson({ pages: {} }, deps);
    const addressing = new Addressing(tree);
    const log = new EventLog();
    const { MemoryVectorIndex } = await import("../src/vector-index-port");
    const { MockEmbeddingPort } = await import("../src/embedding-port");
    const { SemanticIndex } = await import("../src/semantic-index");
    const index = new SemanticIndex(tree, addressing, new MockEmbeddingPort(), new MemoryVectorIndex());
    const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0), ...index.hooks() });
    const ts = makeToolset({ tree, addressing, log, mutator, index }, {});
    // initial fromJson content never passes the index hooks — write via mutations
    mutator.insert({ path: "/pages" }, "a", "casino bonus offers");
    mutator.insert({ path: "/pages" }, "b", "contact form");
    await index.reindex();
    const exec = makeToolExecutor(ts);
    const parsed = parse(await exec("search", { query: "casino bonus offers", k: 1 }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.results.length).toBe(1);
      expect(parsed.value.results[0].path).toBe("/pages/a");
    }
  });
});
