import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DataHora, EventoSchema, FORMATO_DATA_EXEMPLO, type Evento } from "@agenda/api/schemas";
import { z } from "zod";
import { ApiError, type ApiClient } from "./api-client.js";

// ---------------------------------------------------------------------------
// Trechos reaproveitados nas descriptions (as descriptions são o "prompt" da tool)
// ---------------------------------------------------------------------------

const FORMATO = `Datas SEMPRE em ISO 8601 com timezone, ex: ${FORMATO_DATA_EXEMPLO}. Nunca omita o offset; se o usuário não disser o fuso, use o fuso dele (Brasília = -03:00).`;
const RELATIVAS = `Converta datas relativas ("amanhã", "sexta", "semana que vem") para datas absolutas a partir da data atual da conversa antes de chamar.`;
const ID = `O id (UUID) de cada evento vem em toda resposta: guarde-o para buscar, atualizar ou remover depois.`;

const descData = (o: string) => `${o}. ${FORMATO}`;

// ---------------------------------------------------------------------------
// Schemas de entrada/saída
// ---------------------------------------------------------------------------

const IdEvento = z
  .uuid({ error: "id deve ser um UUID; use listar_eventos para descobrir o id do evento" })
  .describe("id (UUID) do evento, obtido em listar_eventos, buscar_evento ou criar_evento");

const Intervalo = {
  de: DataHora.describe(descData("Início do intervalo (inclusivo)")),
  ate: DataHora.describe(descData("Fim do intervalo (exclusivo); deve ser depois de `de`")),
};

const ResumoEvento = EventoSchema.pick({ id: true, titulo: true, inicio: true, fim: true });

const SaidaEvento = { evento: EventoSchema };
const SaidaEventoComConflitos = {
  evento: EventoSchema,
  conflitos: z
    .array(ResumoEvento)
    .describe("Outros eventos que se sobrepõem ao horário deste. Vazio = sem conflito."),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Dados = Record<string, unknown>;

function sucesso(resumo: string, dados: Dados): CallToolResult {
  return {
    content: [{ type: "text", text: `${resumo}\n\n${JSON.stringify(dados, null, 2)}` }],
    structuredContent: dados,
  };
}

function falha(mensagem: string): CallToolResult {
  return { content: [{ type: "text", text: mensagem }], isError: true };
}

/** Converte qualquer erro em resposta isError com mensagem útil ao modelo (sem stack trace). */
async function executar(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 404 && e.message.startsWith("Evento não encontrado")) {
        return falha(`${e.message}. Use listar_eventos para encontrar o id correto.`);
      }
      return falha(e.message);
    }
    console.error("[agenda-mcp] erro inesperado:", e);
    return falha("Erro inesperado no servidor MCP de agenda. Tente novamente; se persistir, avise o usuário.");
  }
}

const resumir = ({ id, titulo, inicio, fim }: Evento) => ({ id, titulo, inicio, fim });

const linha = (e: Evento) => `- ${e.titulo} | ${e.inicio} → ${e.fim} | id ${e.id}`;

async function conflitosDe(api: ApiClient, ev: Evento) {
  const sobrepostos = await api.listar(ev.inicio, ev.fim);
  return sobrepostos.filter((o) => o.id !== ev.id).map(resumir);
}

function avisoConflitos(conflitos: ReturnType<typeof resumir>[]): string {
  if (!conflitos.length) return "Sem conflitos de horário.";
  return `ATENÇÃO: conflita com ${conflitos.length} evento(s):\n${conflitos
    .map((c) => `- ${c.titulo} | ${c.inicio} → ${c.fim} | id ${c.id}`)
    .join("\n")}\nInforme o usuário.`;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function registerTools(server: McpServer, api: ApiClient): void {
  server.registerTool(
    "listar_eventos",
    {
      title: "Listar eventos",
      description: [
        "Lista os eventos da agenda que se sobrepõem a um intervalo de tempo (inclui eventos que começam antes e terminam dentro dele).",
        `Use para perguntas como "o que tenho amanhã?", "como está minha semana?" e para descobrir o id de um evento antes de atualizar ou remover. Para um dia inteiro, use de = 00:00 do dia e ate = 00:00 do dia seguinte.`,
        RELATIVAS,
        FORMATO,
        ID,
      ].join("\n"),
      inputSchema: Intervalo,
      outputSchema: {
        de: z.string(),
        ate: z.string(),
        total: z.number().int(),
        eventos: z.array(EventoSchema).describe("Ordenados por início"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ de, ate }) =>
      executar(async () => {
        const eventos = await api.listar(de, ate);
        const resumo = eventos.length
          ? `${eventos.length} evento(s) entre ${de} e ${ate}:\n${eventos.map(linha).join("\n")}`
          : `Nenhum evento entre ${de} e ${ate}.`;
        return sucesso(resumo, { de, ate, total: eventos.length, eventos });
      }),
  );

  server.registerTool(
    "buscar_evento",
    {
      title: "Buscar evento",
      description: [
        "Retorna todos os dados de um evento pelo id, incluindo a descrição.",
        "Use quando já tiver o id (de uma resposta anterior) e precisar dos detalhes. Se não tiver o id, use listar_eventos primeiro.",
      ].join("\n"),
      inputSchema: { id: IdEvento },
      outputSchema: SaidaEvento,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ id }) =>
      executar(async () => {
        const evento = await api.buscar(id);
        return sucesso(`Evento encontrado:\n${linha(evento)}`, { evento });
      }),
  );

  server.registerTool(
    "criar_evento",
    {
      title: "Criar evento",
      description: [
        `Cria um evento na agenda. Use para pedidos como "marca reunião sexta 14h às 15h".`,
        "Se o usuário não disser o horário de término, pergunte ou assuma 1 hora e avise.",
        "Esta tool NÃO bloqueia sobreposição: o evento é criado mesmo se houver conflito, e os eventos conflitantes vêm no campo `conflitos`. Se não tiver certeza de que o horário está livre, chame verificar_disponibilidade antes e confirme com o usuário.",
        RELATIVAS,
        FORMATO,
        ID,
      ].join("\n"),
      inputSchema: {
        titulo: z.string().min(1).max(200).describe("Título curto do evento, ex: \"Reunião com time de vendas\""),
        inicio: DataHora.describe(descData("Início do evento")),
        fim: DataHora.describe(descData("Fim do evento; deve ser depois de `inicio`")),
        descricao: z.string().max(2000).optional().describe("Detalhes opcionais: pauta, local, link"),
      },
      outputSchema: SaidaEventoComConflitos,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args) =>
      executar(async () => {
        const evento = await api.criar(args);
        const conflitos = await conflitosDe(api, evento);
        return sucesso(`Evento criado:\n${linha(evento)}\n${avisoConflitos(conflitos)}`, {
          evento,
          conflitos,
        });
      }),
  );

  server.registerTool(
    "atualizar_evento",
    {
      title: "Atualizar evento",
      description: [
        "Altera campos de um evento existente. Envie só os campos que mudam; os demais são mantidos.",
        "Use para remarcar, renomear ou mudar a descrição. Para remarcar mantendo a duração, envie `inicio` e `fim` juntos. `descricao: null` apaga a descrição.",
        "Precisa do id: se não tiver, use listar_eventos antes. Não bloqueia sobreposição; conflitos vêm em `conflitos`.",
        RELATIVAS,
        FORMATO,
      ].join("\n"),
      inputSchema: {
        id: IdEvento,
        titulo: z.string().min(1).max(200).optional().describe("Novo título"),
        inicio: DataHora.optional().describe(descData("Novo início")),
        fim: DataHora.optional().describe(descData("Novo fim")),
        descricao: z.string().max(2000).nullable().optional().describe("Nova descrição; null apaga"),
      },
      outputSchema: SaidaEventoComConflitos,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ id, ...campos }) =>
      executar(async () => {
        if (Object.values(campos).every((v) => v === undefined)) {
          return falha("Informe ao menos um campo para atualizar: titulo, inicio, fim ou descricao.");
        }
        const evento = await api.atualizar(id, campos);
        const conflitos = await conflitosDe(api, evento);
        return sucesso(`Evento atualizado:\n${linha(evento)}\n${avisoConflitos(conflitos)}`, {
          evento,
          conflitos,
        });
      }),
  );

  server.registerTool(
    "remover_evento",
    {
      title: "Remover evento",
      description: [
        `Remove (cancela) um evento permanentemente. Não há como desfazer. Use para pedidos como "cancela o evento de quinta".`,
        "Precisa do id: use listar_eventos para encontrá-lo. Se mais de um evento puder corresponder ao pedido, pergunte ao usuário qual antes de remover.",
      ].join("\n"),
      inputSchema: { id: IdEvento },
      outputSchema: { removido: z.literal(true), evento: EventoSchema.describe("Dados do evento removido") },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ id }) =>
      executar(async () => {
        const evento = await api.buscar(id);
        await api.remover(id);
        return sucesso(`Evento removido:\n${linha(evento)}`, { removido: true, evento });
      }),
  );

  server.registerTool(
    "verificar_disponibilidade",
    {
      title: "Verificar disponibilidade",
      description: [
        "Verifica se um intervalo de tempo está livre na agenda e lista os eventos que conflitam, se houver.",
        `Use antes de criar ou remarcar um evento e para perguntas como "estou livre sexta às 14h?".`,
        "Eventos que apenas encostam na borda (um termina às 15h, outro começa às 15h) NÃO conflitam.",
        RELATIVAS,
        FORMATO,
      ].join("\n"),
      inputSchema: Intervalo,
      outputSchema: {
        livre: z.boolean(),
        de: z.string(),
        ate: z.string(),
        conflitos: z.array(ResumoEvento),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ de, ate }) =>
      executar(async () => {
        const conflitos = (await api.listar(de, ate)).map(resumir);
        const livre = conflitos.length === 0;
        const resumo = livre
          ? `Livre: nenhum evento entre ${de} e ${ate}.`
          : `Ocupado: ${conflitos.length} conflito(s) entre ${de} e ${ate}:\n${conflitos
              .map((c) => `- ${c.titulo} | ${c.inicio} → ${c.fim} | id ${c.id}`)
              .join("\n")}`;
        return sucesso(resumo, { livre, de, ate, conflitos });
      }),
  );
}
