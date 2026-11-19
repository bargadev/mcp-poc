import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { ROOT } from "./config.js";

/**
 * Spawns agenda-mcp as a subprocess (stdio), on the same Node, exactly like
 * Claude Code or the Inspector would.
 */
export async function connectMcp(apiUrl: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", resolve(ROOT, "packages/agenda-mcp/src/index.ts")],
    cwd: ROOT,
    env: { ...(process.env as Record<string, string>), AGENDA_API_URL: apiUrl },
    stderr: "inherit",
  });
  const client = new Client({ name: "agenda-chat", version: "0.1.0" });
  await client.connect(transport);
  return client;
}
