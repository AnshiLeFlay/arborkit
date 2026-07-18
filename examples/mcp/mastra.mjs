import { MCPClient } from "@mastra/mcp";

const client = new MCPClient({
  servers: {
    arborkit: {
      command: "npx",
      args: ["-y", "@arborkit/mcp", "--config", "/absolute/path/arborkit.mcp.mjs"],
    },
  },
});

console.log(Object.keys(await client.getTools()));
await client.disconnect();
