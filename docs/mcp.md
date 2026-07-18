# MCP server

`@arborkit/mcp` exposes one live ArborKit artifact to any standard MCP client.
It is a separate package so the embedded `arborkit` core keeps zero runtime
dependencies.

## Install and run in under 15 minutes

```bash
npm install arborkit @arborkit/mcp
```

Create `arborkit.mcp.mjs`:

```js
import { createArbor, sizeBasedDecision } from "arborkit";
import { defineArborMcpConfig } from "@arborkit/mcp";

export default defineArborMcpConfig({
  artifactId: "content-site",
  profile: "editor",
  binding: {
    owner: "mcp:content-editor",
    readScope: "/pages",
    writeScope: "/pages",
  },
  createArbor() {
    return createArbor({
      initial: { pages: {}, plan: "" },
      decompose: sizeBasedDecision(1),
    });
  },
});
```

Run local stdio (the default):

```bash
npx arborkit-mcp --config ./arborkit.mcp.mjs
```

Or stateless Streamable HTTP:

```bash
npx arborkit-mcp --config ./arborkit.mcp.mjs --transport http --port 3000
# http://127.0.0.1:3000/mcp
```

The config factory owns artifact creation or restore, registry, decomposition,
embeddings, and persistence. The CLI never guesses how a snapshot was built.
Return one `Arbor` instance; every request in that process shares it.

## Programmatic API

Applications can bypass the CLI and own transport lifecycle directly:

```js
import { createArbor } from "arborkit";
import { startHttp, startStdio } from "@arborkit/mcp";

const options = {
  arbor: createArbor({ initial: { pages: {} } }),
  artifactId: "content-site",
  profile: "reader",
};

const http = await startHttp(options, { host: "127.0.0.1", port: 3000 });
// Or: const stdio = await startStdio(options);
await http.close();
```

`createArborMcpServer(options)` returns the low-level official SDK `Server` when
an application needs to connect a custom transport itself.

## Safety surface

MCP defaults to `profile: "reader"`. Choose `editor` or `admin` explicitly:

- `reader`: search, find, describe, get, history, and time-travel reads;
- `editor`: adds set/edit/insert/move, but omits remove/revert/unrestricted batch;
- `admin`: the complete 13-tool Agent Bridge surface.

`include` intersects the profile and cannot grant an omitted capability.
`binding.readScope` applies to tools and tree/history resources;
`binding.writeScope` and `owner` flow into the core toolset. `guard`, `approval`,
`ifVersion`, `STALE_VERSION`, and atomic `batch_patch` behave exactly as they do
in-process.

Enable the read-only native analysis surface explicitly:

```js
analysis: { include: ["cluster", "outliers", "structural_groups"] }
```

## Resources

For `artifactId: "content-site"` the server publishes:

| URI | Content |
| --- | --- |
| `arborkit://content-site/tree` | Tree rooted at `readScope`, or the artifact root |
| `arborkit://content-site/node/{nodeId}` | Scoped subtree by stable node id |
| `arborkit://content-site/history` | Scoped mutation history |
| `arborkit://content-site/history/{nodeId}` | History of one scoped node |
| `arborkit://content-site/version` | Current version, compaction floor, retained events |
| `arborkit://content-site/types` | Serializable registry/type metadata |

Defaults are `maxDepth: 4`, `historyLimit: 100`, and
`maxResultChars: 100_000`. Override them under `resources`. An out-of-scope node
id is reported as resource-not-found rather than revealing whether it exists.

## Client configuration

### Claude Desktop and Claude Code

```json
{
  "mcpServers": {
    "arborkit": {
      "command": "npx",
      "args": ["-y", "@arborkit/mcp", "--config", "/absolute/path/arborkit.mcp.mjs"]
    }
  }
}
```

On native Windows, use `"command": "cmd"` and begin `args` with
`["/c", "npx", ...]`. Claude Code can also use:

```bash
claude mcp add arborkit -- npx -y @arborkit/mcp --config /absolute/path/arborkit.mcp.mjs
```

### AI SDK

```js
import { createMCPClient } from "@ai-sdk/mcp";

const client = await createMCPClient({
  transport: { type: "http", url: "http://127.0.0.1:3000/mcp" },
});
const tools = await client.tools();
```

### Mastra

```js
import { MCPClient } from "@mastra/mcp";

const mcp = new MCPClient({
  servers: {
    arborkit: {
      command: "npx",
      args: ["-y", "@arborkit/mcp", "--config", "/absolute/path/arborkit.mcp.mjs"],
    },
  },
});
const tools = await mcp.getTools();
```

### LangGraph / LangChain JS

```js
import { MultiServerMCPClient } from "@langchain/mcp-adapters";

const mcp = new MultiServerMCPClient({
  arborkit: { transport: "http", url: "http://127.0.0.1:3000/mcp" },
});
const tools = await mcp.getTools();
// Pass tools into a LangChain agent or a LangGraph tool node.
```

Copyable files for these configurations live under [`examples/mcp`](../examples/mcp).

## HTTP boundaries

HTTP defaults to `127.0.0.1` and validates the Host header. A non-loopback bind
requires one or more `--allowed-host` flags, but this is not authentication.
Put remote deployments behind an authenticated reverse proxy. Stateful MCP
sessions, resumability, OAuth, rate limits, multi-artifact lifecycle, and a
serialized service writer remain later roadmap stages.
