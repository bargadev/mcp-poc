import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DATE_FORMAT_EXAMPLE } from "@agenda/api/schemas";
import type { ApiClient } from "./api-client.js";
import { registerBatchTools } from "./batch-tools.js";
import { registerTools } from "./tools.js";

const INSTRUCTIONS = `The user's personal agenda server (events with title, description, start and end).
- All dates in ISO 8601 with a timezone, e.g. ${DATE_FORMAT_EXAMPLE}.
- To update or delete, find the id with list_events; never make up ids.
- Before creating or rescheduling, prefer check_availability and warn the user about conflicts.
- Several events at once: create_recurring_events (weekly pattern), create_events_batch or delete_events_batch. Never call the single-event tool repeatedly.
- When replying to the user, show times in their timezone, in natural language.`;

export function createServer({ api }: { api: ApiClient }): McpServer {
  const server = new McpServer(
    { name: "agenda", title: "Agenda", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server, api);
  registerBatchTools(server, api);
  return server;
}
