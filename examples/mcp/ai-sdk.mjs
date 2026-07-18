import { createMCPClient } from "@ai-sdk/mcp";

const client = await createMCPClient({
  transport: { type: "http", url: "http://127.0.0.1:3000/mcp" },
});

console.log(Object.keys(await client.tools()));
await client.close();
