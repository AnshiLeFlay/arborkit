import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseCliArgs } from "../src/cli";

describe("arborkit-mcp CLI", () => {
  it("parses transport flags and repeated allowed hosts", () => {
    expect(parseCliArgs([
      "--config", "server.mjs",
      "--transport", "http",
      "--host", "0.0.0.0",
      "--port", "3210",
      "--allowed-host", "one.example",
      "--allowed-host", "two.example",
    ])).toEqual({
      config: "server.mjs",
      transport: "http",
      host: "0.0.0.0",
      port: 3210,
      allowedHosts: ["one.example", "two.example"],
    });
    expect(() => parseCliArgs([])).toThrow(/--config is required/);
  });

  it("connects through the built stdio bin with no custom adapter", async () => {
    const packageRoot = resolve(import.meta.dirname, "..");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        resolve(packageRoot, "dist/cli.js"),
        "--config",
        resolve(packageRoot, "test/fixtures/stdio-config.mjs"),
      ],
      cwd: packageRoot,
      stderr: "pipe",
    });
    const client = new Client({ name: "arborkit-stdio-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("get");
      const version = await client.readResource({ uri: "arborkit://cli-fixture/version" });
      expect(JSON.parse((version.contents[0] as { text: string }).text)).toMatchObject({ artifactId: "cli-fixture" });
    } finally {
      await client.close();
    }
  }, 20_000);
});
