# @arborkit/mcp

Standard MCP tools and resources for one live ArborKit artifact. Supports local
stdio and stateless Streamable HTTP.

```bash
npm install arborkit @arborkit/mcp
npx arborkit-mcp --config ./arborkit.mcp.mjs
```

See the full MCP guide in the ArborKit repository.

In `1.6.0-alpha`, `createArbor()` may return a `DurableArborSession`. MCP writes
then return only after the authoritative SQLite/PostgreSQL commit succeeds.
