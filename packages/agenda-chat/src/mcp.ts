import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { RAIZ } from "./config.js";

/**
 * Sobe o agenda-mcp como subprocesso (stdio), no mesmo Node, exatamente como o
 * Claude Code ou o Inspector fariam.
 */
export async function conectarMcp(apiUrl: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", resolve(RAIZ, "packages/agenda-mcp/src/index.ts")],
    cwd: RAIZ,
    env: { ...(process.env as Record<string, string>), AGENDA_API_URL: apiUrl },
    stderr: "inherit",
  });
  const client = new Client({ name: "agenda-chat", version: "0.1.0" });
  await client.connect(transport);
  return client;
}
