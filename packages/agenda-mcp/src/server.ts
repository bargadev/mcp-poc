import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FORMATO_DATA_EXEMPLO } from "@agenda/api/schemas";
import type { ApiClient } from "./api-client.js";
import { registerBatchTools } from "./tools-lote.js";
import { registerTools } from "./tools.js";

const INSTRUCOES = `Servidor da agenda pessoal do usuário (eventos com título, descrição, início e fim).
- Todas as datas em ISO 8601 com timezone, ex: ${FORMATO_DATA_EXEMPLO}.
- Para alterar ou remover, descubra o id com listar_eventos; nunca invente ids.
- Antes de criar ou remarcar, prefira verificar_disponibilidade e avise o usuário sobre conflitos.
- Vários eventos de uma vez: criar_eventos_recorrentes (padrão semanal), criar_eventos_em_lote ou remover_eventos_em_lote. Nunca repita a tool individual em sequência.
- Ao responder ao usuário, mostre horários no fuso dele, em linguagem natural.`;

export function createServer({ api }: { api: ApiClient }): McpServer {
  const server = new McpServer(
    { name: "agenda", title: "Agenda", version: "0.1.0" },
    { instructions: INSTRUCOES },
  );
  registerTools(server, api);
  registerBatchTools(server, api);
  return server;
}
