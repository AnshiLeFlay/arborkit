import { MultiServerMCPClient } from "@langchain/mcp-adapters";

const client = new MultiServerMCPClient({
  arborkit: { transport: "http", url: "http://127.0.0.1:3000/mcp" },
});

console.log((await client.getTools()).map((tool) => tool.name));
await client.close();
