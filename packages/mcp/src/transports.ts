import type { Server as HttpServer } from "node:http";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createArborMcpServer, normalizeArborMcpOptions, type ArborMcpServerOptions } from "./server";

export interface RunningArborMcpServer {
  close(): Promise<void>;
}

export interface RunningArborMcpHttpServer extends RunningArborMcpServer {
  readonly url: string;
  readonly httpServer: HttpServer;
}

export interface ArborMcpHttpOptions {
  host?: string;
  port?: number;
  allowedHosts?: string[];
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export async function startStdio(options: ArborMcpServerOptions): Promise<RunningArborMcpServer> {
  const server = createArborMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  let closed = false;
  return {
    close: async () => {
      if (closed) return;
      closed = true;
      await server.close();
      await options.session?.close();
    },
  };
}

export async function startHttp(
  input: ArborMcpServerOptions,
  httpOptions: ArborMcpHttpOptions = {},
): Promise<RunningArborMcpHttpServer> {
  const options = normalizeArborMcpOptions(input);
  const host = httpOptions.host ?? "127.0.0.1";
  const port = httpOptions.port ?? 3000;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new TypeError("port must be an integer from 0 to 65535");
  if (!LOOPBACK.has(host) && (!httpOptions.allowedHosts || httpOptions.allowedHosts.length === 0)) {
    throw new TypeError("non-loopback HTTP bind requires at least one allowedHosts entry; authentication is not provided");
  }

  const app = createMcpExpressApp({ host, allowedHosts: httpOptions.allowedHosts });
  const active = new Set<{ server: Server; transport: StreamableHTTPServerTransport }>();
  app.post("/mcp", async (req, res) => {
    const server = createArborMcpServer(options);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const entry = { server, transport };
    active.add(entry);
    const cleanup = async () => {
      if (!active.delete(entry)) return;
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    };
    res.once("close", () => void cleanup());
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
      console.error("ArborKit MCP HTTP request failed:", error);
    } finally {
      await cleanup();
    }
  });
  const methodNotAllowed = (_req: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  const httpServer = await new Promise<HttpServer>((resolve, reject) => {
    const listener = app.listen(port, host, () => resolve(listener));
    listener.once("error", reject);
  });
  const address = httpServer.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  const urlHost = host.includes(":") ? `[${host}]` : host;
  let closed = false;
  return {
    url: `http://${urlHost}:${actualPort}/mcp`,
    httpServer,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
      await Promise.all([...active].map(async ({ server, transport }) => {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      }));
      active.clear();
      await options.session?.close();
    },
  };
}
