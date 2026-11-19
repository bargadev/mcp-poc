import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { criarApiClient } from "./api-client.js";
import { createServer } from "./server.js";

// stdout é o canal JSON-RPC: qualquer log vai para stderr.
const baseUrl = process.env.AGENDA_API_URL ?? "http://localhost:3002";
const server = createServer({ api: criarApiClient({ baseUrl }) });

await server.connect(new StdioServerTransport());
console.error(`[agenda-mcp] pronto (stdio) → API em ${baseUrl}`);
