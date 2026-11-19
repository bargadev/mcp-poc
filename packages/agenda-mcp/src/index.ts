import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApiClient } from "./api-client.js";
import { createServer } from "./server.js";

// stdout is the JSON-RPC channel: every log goes to stderr.
const baseUrl = process.env.AGENDA_API_URL ?? "http://localhost:3002";
const server = createServer({ api: createApiClient({ baseUrl }) });

await server.connect(new StdioServerTransport());
console.error(`[agenda-mcp] ready (stdio) → API at ${baseUrl}`);
