import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const t = new StdioClientTransport({
  command: "pnpm",
  args: ["--dir", process.env.ROOT!, "dev:mcp"],
  env: { ...process.env, AGENDA_API_URL: "http://localhost:3999" } as Record<string, string>,
  stderr: "pipe",
});
let err = ""; t.stderr?.on("data", (d) => (err += d));
const c = new Client({ name: "e2e", version: "0" });
await c.connect(t);
const call = async (name: string, args: object) => {
  const r: any = await c.callTool({ name, arguments: args as Record<string, unknown> });
  console.log(`\n### ${name} isError=${!!r.isError}\n${r.content[0].text.split("\n\n")[0]}`);
  return r;
};
console.log("tools:", (await c.listTools()).tools.map((x) => x.name).join(", "));
const l = await call("listar_eventos", { de: "2026-11-20T00:00:00-03:00", ate: "2026-11-21T00:00:00-03:00" });
await call("verificar_disponibilidade", { de: "2026-11-20T12:30:00-03:00", ate: "2026-11-20T13:00:00-03:00" });
const cr = await call("criar_evento", { titulo: "Reunião sexta", inicio: "2026-11-20T13:00:00-03:00", fim: "2026-11-20T14:00:00-03:00" });
await call("criar_evento", { titulo: "x", inicio: "2026-11-20T15:00:00-03:00", fim: "2026-11-20T14:00:00-03:00" });
await call("criar_evento", { titulo: "x", inicio: "amanhã 14h", fim: "2026-11-20T14:00:00-03:00" });
await call("atualizar_evento", { id: cr.structuredContent.evento.id, inicio: "2026-11-20T16:00:00-03:00" });
await call("remover_evento", { id: cr.structuredContent.evento.id });
await call("buscar_evento", { id: cr.structuredContent.evento.id });
await c.close();
console.log("\n[stderr do server]", err.trim().split("\n").slice(-2).join(" | "));
