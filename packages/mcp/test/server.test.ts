import { afterEach, describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import {
  createArbor,
  MemoryDurableStore,
  openDurableArbor,
  SeqIdGen,
  sizeBasedDecision,
  TypeRegistry,
  type Arbor,
} from "arborkit";
import { createArborMcpServer, startHttp } from "../src";

async function linkedClient(options: Parameters<typeof createArborMcpServer>[0]) {
  const server = createArborMcpServer(options);
  const client = new Client({ name: "arborkit-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function fixture(registry?: TypeRegistry): Arbor {
  return createArbor({
    initial: { public: { text: "old", nested: { value: 1 } }, secret: { token: "hidden" } },
    idGen: new SeqIdGen(),
    decompose: sizeBasedDecision(1),
    registry,
  });
}

describe("ArborKit MCP tools", () => {
  it("defaults to reader and preserves JSON/output schemas and annotations", async () => {
    expect(() => createArborMcpServer({ arbor: fixture(), artifactId: "bad/id" })).toThrow(/URL-safe/);
    const linked = await linkedClient({ arbor: fixture(), artifactId: "Docs" });
    try {
      const { tools } = await linked.client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["search", "find", "describe", "get", "history", "get_at"]);
      const get = tools.find((tool) => tool.name === "get")!;
      expect(get.inputSchema.type).toBe("object");
      expect(get.outputSchema?.type).toBe("object");
      expect(get.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    } finally {
      await linked.close();
    }
  });

  it("returns text plus structured content and keeps optimistic concurrency errors", async () => {
    const arbor = fixture();
    const linked = await linkedClient({ arbor, artifactId: "docs", profile: "admin" });
    try {
      const tools = await linked.client.listTools();
      expect(tools.tools.find((tool) => tool.name === "set_value")?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });
      const before = await linked.client.callTool({ name: "get", arguments: { path: "/public/text" } });
      const version = (before.structuredContent as { value: { meta: { version: number } } }).value.meta.version;
      const changed = await linked.client.callTool({
        name: "set_value",
        arguments: { path: "/public/text", value: "new", ifVersion: version },
      });
      expect(changed.isError).not.toBe(true);
      expect(changed.structuredContent).toMatchObject({ ok: true, value: { path: "/public/text" } });
      expect((changed.content as Array<{ type: string }>)[0]).toMatchObject({ type: "text" });

      const stale = await linked.client.callTool({
        name: "set_value",
        arguments: { path: "/public/text", value: "again", ifVersion: version },
      });
      expect(stale.isError).toBe(true);
      expect(stale.structuredContent).toMatchObject({ ok: false, error: { code: "STALE_VERSION" } });
    } finally {
      await linked.close();
    }
  });

  it("applies include as an intersection and preserves guard/approval before writes", async () => {
    const arbor = fixture();
    let approvals = 0;
    const linked = await linkedClient({
      arbor,
      artifactId: "docs",
      profile: "editor",
      include: ["get", "set_value", "remove"],
      guard: (name, input) => name === "set_value" && input.value === "blocked"
        ? { code: "POLICY", message: "blocked" }
        : null,
      approval: async () => {
        approvals += 1;
        return true;
      },
    });
    try {
      expect((await linked.client.listTools()).tools.map((tool) => tool.name)).toEqual(["get", "set_value"]);
      const refused = await linked.client.callTool({
        name: "set_value",
        arguments: { path: "/public/text", value: "blocked" },
      });
      expect(refused.structuredContent).toMatchObject({ ok: false, error: { code: "POLICY" } });
      expect(approvals).toBe(0);
      expect(arbor.tree.toJson()).toMatchObject({ public: { text: "old" } });
    } finally {
      await linked.close();
    }
  });

  it("keeps batch_patch atomic across the MCP boundary", async () => {
    const arbor = fixture();
    const linked = await linkedClient({ arbor, artifactId: "docs", profile: "admin" });
    try {
      const failed = await linked.client.callTool({
        name: "batch_patch",
        arguments: {
          operations: [
            { op: "set_value", path: "/public/text", value: "temporary" },
            { op: "set_value", path: "/missing", value: "fails" },
          ],
        },
      });
      expect(failed.isError).toBe(true);
      expect(failed.structuredContent).toMatchObject({ ok: false, error: { code: "NODE_NOT_FOUND" } });
      expect(arbor.tree.toJson()).toMatchObject({ public: { text: "old" } });
      expect(arbor.log.length()).toBe(0);
    } finally {
      await linked.close();
    }
  });

  it("adds native analysis only when explicitly enabled", async () => {
    const without = await linkedClient({ arbor: fixture(), artifactId: "docs" });
    const withAnalysis = await linkedClient({ arbor: fixture(), artifactId: "docs", analysis: { include: ["structural_groups"] } });
    try {
      expect((await without.client.listTools()).tools.some((tool) => tool.name === "structural_groups")).toBe(false);
      expect((await withAnalysis.client.listTools()).tools.some((tool) => tool.name === "structural_groups")).toBe(true);
    } finally {
      await without.close();
      await withAnalysis.close();
    }
  });

  it("commits durable mutations before returning and keeps tool schemas unchanged", async () => {
    const store = new MemoryDurableStore();
    const session = await openDurableArbor({
      artifactId: "durable",
      store,
      config: { decomposition: { id: "size-based", version: "1" } },
      arbor: {
        initial: { public: { text: "old" } },
        decompose: sizeBasedDecision(1),
      },
    });
    const linked = await linkedClient({
      session,
      artifactId: "durable",
      profile: "admin",
      idempotencyKey: () => "mcp-request-1",
    });
    try {
      const changed = await linked.client.callTool({
        name: "set_value",
        arguments: { path: "/public/text", value: "new" },
      });
      expect(changed.structuredContent).toMatchObject({ ok: true });
      expect((await store.load("durable"))?.currentVersion).toBe(1);

      const reused = await linked.client.callTool({
        name: "set_value",
        arguments: { path: "/public/text", value: "other" },
      });
      expect(reused.structuredContent).toMatchObject({
        ok: false,
        error: { code: "IDEMPOTENCY_CONFLICT" },
      });
      expect(session.arbor.tree.toJson()).toEqual({ public: { text: "new" } });
    } finally {
      await linked.close();
    }
  });
});

describe("ArborKit MCP resources", () => {
  it("lists and reads scoped tree, node, history, version and type metadata", async () => {
    const registry = new TypeRegistry();
    registry.register("page", { description: "Page", jsonSchema: { type: "object" }, decompose: "children" });
    const arbor = fixture(registry);
    const seeded = await arbor.toolset({ owner: "seed" }).patch(
      { path: "/public/text" },
      { op: "set", value: "updated" },
    );
    expect(seeded.ok).toBe(true);
    const publicNode = arbor.addressing.byPath("/public")!;
    const linked = await linkedClient({
      arbor,
      artifactId: "Docs",
      binding: { readScope: "/public", writeScope: "/public" },
      resources: { maxDepth: 2 },
    });
    try {
      expect((await linked.client.listResources()).resources).toHaveLength(4);
      expect((await linked.client.listResourceTemplates()).resourceTemplates).toHaveLength(2);

      const tree = await linked.client.readResource({ uri: "arborkit://docs/tree" });
      const treeValue = JSON.parse((tree.contents[0] as { text: string }).text);
      expect(treeValue).toMatchObject({ path: "/public", content: { text: "updated" } });
      expect(JSON.stringify(treeValue)).not.toContain("hidden");

      const node = await linked.client.readResource({ uri: `arborkit://docs/node/${publicNode.id}` });
      expect(JSON.parse((node.contents[0] as { text: string }).text)).toMatchObject({ id: publicNode.id });

      const version = await linked.client.readResource({ uri: "arborkit://docs/version" });
      expect(JSON.parse((version.contents[0] as { text: string }).text)).toEqual({
        artifactId: "docs",
        version: 1,
        historyBaseVersion: 0,
        retainedEvents: 1,
      });

      const history = await linked.client.readResource({ uri: "arborkit://docs/history" });
      expect(JSON.parse((history.contents[0] as { text: string }).text)).toMatchObject([
        { path: "/public/text", actor: "seed", kind: "set" },
      ]);
      const textNode = arbor.addressing.byPath("/public/text")!;
      const nodeHistory = await linked.client.readResource({ uri: `arborkit://docs/history/${textNode.id}` });
      expect(JSON.parse((nodeHistory.contents[0] as { text: string }).text)).toHaveLength(1);

      const types = await linked.client.readResource({ uri: "arborkit://docs/types" });
      expect(JSON.parse((types.contents[0] as { text: string }).text)).toMatchObject({
        types: [{ name: "page", description: "Page", hasValidator: false }],
      });
    } finally {
      await linked.close();
    }
  });

  it("masks out-of-scope node ids and rejects oversized resources", async () => {
    const arbor = fixture();
    const secret = arbor.addressing.byPath("/secret")!;
    const scoped = await linkedClient({
      arbor,
      artifactId: "docs",
      binding: { readScope: "/public" },
      resources: { maxResultChars: 30 },
    });
    try {
      await expect(scoped.client.readResource({ uri: `arborkit://docs/node/${secret.id}` })).rejects.toMatchObject({ code: -32002 });
      await expect(scoped.client.readResource({ uri: "arborkit://docs/tree" })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      await expect(scoped.client.readResource({ uri: "arborkit://other/tree" })).rejects.toMatchObject({ code: -32002 });
      await expect(scoped.client.readResource({ uri: "not a uri" })).rejects.toMatchObject({ code: -32002 });
    } finally {
      await scoped.close();
    }
  });
});

describe("ArborKit MCP Streamable HTTP", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  it("serves a standard stateless HTTP client and protects non-loopback binds", async () => {
    await expect(startHttp({ arbor: fixture(), artifactId: "docs" }, { host: "0.0.0.0", port: 0 })).rejects.toThrow(
      /allowedHosts/,
    );
    const running = await startHttp({ arbor: fixture(), artifactId: "docs" }, { port: 0 });
    closers.push(() => running.close());
    const client = new Client({ name: "arborkit-http-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(running.url)));
    closers.push(() => client.close());
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("get");
    expect((await client.readResource({ uri: "arborkit://docs/version" })).contents).toHaveLength(1);

    const badHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      const request = httpRequest(running.url, {
        method: "POST",
        headers: {
          host: "evil.example",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      });
      request.on("error", reject);
      request.end(body);
    });
    expect(badHostStatus).toBe(403);
  });
});
