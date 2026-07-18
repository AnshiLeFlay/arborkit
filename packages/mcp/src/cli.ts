#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ArborMcpConfig } from "./config";
import { resolveArborMcpConfig } from "./config";
import { startHttp, startStdio, type RunningArborMcpServer } from "./transports";

interface CliOptions {
  config: string;
  transport: "stdio" | "http";
  host?: string;
  port?: number;
  allowedHosts: string[];
}

function usage(): string {
  return "Usage: arborkit-mcp --config <file.mjs> [--transport stdio|http] [--host <host>] [--port <port>] [--allowed-host <host>]";
}

export function parseCliArgs(args: string[]): CliOptions {
  let config: string | undefined;
  let transport: "stdio" | "http" = "stdio";
  let host: string | undefined;
  let port: number | undefined;
  const allowedHosts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = () => {
      const next = args[index + 1];
      if (next === undefined) throw new TypeError(`missing value after ${arg}`);
      index += 1;
      return next;
    };
    if (arg === "--config") config = value();
    else if (arg === "--transport") {
      const requested = value();
      if (requested !== "stdio" && requested !== "http") throw new TypeError("--transport must be stdio or http");
      transport = requested;
    } else if (arg === "--host") host = value();
    else if (arg === "--port") {
      port = Number(value());
      if (!Number.isInteger(port)) throw new TypeError("--port must be an integer");
    } else if (arg === "--allowed-host") allowedHosts.push(value());
    else if (arg === "--help" || arg === "-h") throw new TypeError(usage());
    else throw new TypeError(`unknown argument ${arg}`);
  }
  if (config === undefined) throw new TypeError(`--config is required\n${usage()}`);
  return { config, transport, host, port, allowedHosts };
}

async function loadConfig(path: string): Promise<ArborMcpConfig> {
  const module: { default?: unknown } = await import(pathToFileURL(resolve(path)).href);
  const config = module.default;
  if (typeof config !== "object" || config === null || typeof (config as ArborMcpConfig).createArbor !== "function") {
    throw new TypeError("config default export must be created with defineArborMcpConfig() and provide createArbor()");
  }
  return config as ArborMcpConfig;
}

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  const options = await resolveArborMcpConfig(await loadConfig(cli.config));
  let running: RunningArborMcpServer;
  if (cli.transport === "http") {
    const http = await startHttp(options, {
      host: cli.host,
      port: cli.port,
      allowedHosts: cli.allowedHosts.length > 0 ? cli.allowedHosts : undefined,
    });
    running = http;
    console.error(`ArborKit MCP listening at ${http.url}`);
  } else {
    running = await startStdio(options);
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await running.close();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
