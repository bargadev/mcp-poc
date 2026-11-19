import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DataHora, EventoSchema, MAX_LOTE, type CriarEvento, type Evento } from "@agenda/api/schemas";
import { z } from "zod";
import { ApiError, type ApiClient } from "./api-client.js";
import { DIAS_SEMANA, expandirRecorrencia } from "./recorrencia.js";

const ResumoEvento = EventoSchema.pick({ id: true, titulo: true, inicio: true, fim: true });
type Resumo = z.infer<typeof ResumoEvento>;

const SaidaLote = {
  total: z.number().int(),
  eventos: z.array(ResumoEvento).describe("Eventos criados, em ordem de início"),
  conflitos: z
    .array(z.object({ ocorrencia: ResumoEvento, existente: ResumoEvento }))
    .describe("Pares (evento criado, evento que já existia) com horário sobreposto"),
};

const resumir = ({ id, titulo, inicio, fim }: Evento): Resumo => ({ id, titulo, inicio, fim });
const linha = (e: Resumo) => `- ${e.titulo} | ${e.inicio} → ${e.fim} | id ${e.id}`;

function sucesso(resumo: string, dados: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: `${resumo}\n\n${JSON.stringify(dados)}` }], structuredContent: dados };
}

function falha(mensagem: string): CallToolResult {
  return { content: [{ type: "text", text: mensagem }], isError: true };
}

async function executar(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError) return falha(e.message);
    console.error("[agenda-mcp] erro inesperado:", e);
    return falha("Erro inesperado no servidor MCP de agenda. Tente novamente; se persistir, avise o usuário.");
  }
}

/** Lista longa vira começo + fim, para não inundar o contexto do modelo. */
function listarCompacto(eventos: Resumo[], max = 30): string {
  if (eventos.length <= max) return eventos.map(linha).join("\n");
  return [
    ...eventos.slice(0, 5).map(linha),
    `- … (+${eventos.length - 6} eventos; use listar_eventos no período para ver todos os ids)`,
    linha(eventos.at(-1)!),
  ].join("\n");
}

/** Cria em lote (atômico na API) e cruza com o que já existia no período. */
async function criarEConferir(api: ApiClient, novos: CriarEvento[]) {
  const { eventos } = await api.criarVarios(novos);
  const criados = eventos.map(resumir).sort((a, b) => Date.parse(a.inicio) - Date.parse(b.inicio));
  const idsNovos = new Set(criados.map((e) => e.id));
  const ini = criados.reduce((m, e) => Math.min(m, Date.parse(e.inicio)), Infinity);
  const fim = criados.reduce((m, e) => Math.max(m, Date.parse(e.fim)), -Infinity);
  const existentes = (await api.listar(new Date(ini).toISOString(), new Date(fim).toISOString()))
    .filter((e) => !idsNovos.has(e.id))
    .map(resumir);
  const conflitos = criados.flatMap((ocorrencia) =>
    existentes
      .filter((x) => Date.parse(x.inicio) < Date.parse(ocorrencia.fim) && Date.parse(x.fim) > Date.parse(ocorrencia.inicio))
      .map((existente) => ({ ocorrencia, existente })),
  );
  return { criados, conflitos };
}

function textoConflitos(conflitos: { ocorrencia: Resumo; existente: Resumo }[]): string {
  if (!conflitos.length) return "Sem conflitos de horário.";
  const linhas = conflitos
    .slice(0, 10)
    .map((c) => `- ${c.ocorrencia.inicio}: conflita com "${c.existente.titulo}" (${c.existente.inicio} → ${c.existente.fim})`);
  const resto = conflitos.length > 10 ? `\n- … (+${conflitos.length - 10})` : "";
  return `ATENÇÃO: ${conflitos.length} conflito(s):\n${linhas.join("\n")}${resto}\nInforme o usuário.`;
}

const HoraHHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM em 24h, ex: 19:30");

export function registerBatchTools(server: McpServer, api: ApiClient): void {
  server.registerTool(
    "criar_eventos_recorrentes",
    {
      title: "Criar eventos recorrentes",
      description: [
        `Cria uma série semanal de eventos de uma vez: "jiu-jitsu toda seg, qua e sex 19h30 às 20h30 até o fim do ano", "daily de seg a sex às 9h".`,
        "SEMPRE use esta tool para repetições, em vez de chamar criar_evento várias vezes. Uma chamada cria todas as ocorrências (atômico: ou cria todas, ou nenhuma).",
        "A agenda não guarda regra de recorrência: cada ocorrência vira um evento independente, com id próprio.",
        `Máximo de ${MAX_LOTE} ocorrências por chamada. Se o usuário não disser até quando, pergunte (ou sugira o fim do ano).`,
        "Converta datas relativas para absolutas a partir da data atual da conversa.",
      ].join("\n"),
      inputSchema: {
        titulo: z.string().min(1).max(200).describe("Título de cada ocorrência"),
        descricao: z.string().max(2000).optional().describe("Descrição opcional, repetida em todas"),
        diasDaSemana: z
          .array(z.enum(DIAS_SEMANA))
          .min(1)
          .describe('Dias da semana: "dom", "seg", "ter", "qua", "qui", "sex", "sab"'),
        horaInicio: HoraHHMM.describe('Hora de início, "HH:MM" 24h, ex: "19:30"'),
        horaFim: HoraHHMM.describe('Hora de fim no mesmo dia, "HH:MM" 24h, ex: "20:30"'),
        de: z.iso.date().describe('Primeiro dia do período (inclusivo), "YYYY-MM-DD"'),
        ate: z.iso.date().describe('Último dia do período (inclusivo), "YYYY-MM-DD"'),
        offset: z
          .string()
          .regex(/^[+-]\d\d:\d\d$/, 'use o formato "-03:00"')
          .default("-03:00")
          .describe('Offset do fuso do usuário, ex: "-03:00" (Brasília)'),
      },
      outputSchema: SaidaLote,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      executar(async () => {
        if (args.horaFim <= args.horaInicio) return falha("horaFim deve ser depois de horaInicio (no mesmo dia).");
        if (args.ate < args.de) return falha("ate deve ser igual ou depois de de.");
        const novos = expandirRecorrencia(args);
        if (!novos.length) return falha("Nenhum dia do período cai nos dias da semana pedidos. Nada foi criado.");
        if (novos.length > MAX_LOTE) {
          return falha(
            `Isso geraria ${novos.length} eventos; o máximo é ${MAX_LOTE} por chamada. Divida o período em partes.`,
          );
        }
        const { criados, conflitos } = await criarEConferir(api, novos);
        const regra = `${args.diasDaSemana.join("/")} ${args.horaInicio}–${args.horaFim}, de ${args.de} a ${args.ate}`;
        return sucesso(
          `Criados ${criados.length} eventos "${args.titulo}" (${regra}):\n${listarCompacto(criados)}\n${textoConflitos(conflitos)}`,
          { total: criados.length, eventos: criados, conflitos },
        );
      }),
  );

  server.registerTool(
    "criar_eventos_em_lote",
    {
      title: "Criar eventos em lote",
      description: [
        "Cria vários eventos diferentes numa única chamada (atômico: ou cria todos, ou nenhum).",
        "Use sempre que for criar 2 ou mais eventos que NÃO seguem um padrão semanal (para padrão semanal, use criar_eventos_recorrentes).",
        "Datas em ISO 8601 com timezone, ex: 2026-11-20T15:00:00-03:00.",
      ].join("\n"),
      inputSchema: {
        eventos: z
          .array(
            z.object({
              titulo: z.string().min(1).max(200),
              inicio: DataHora,
              fim: DataHora,
              descricao: z.string().max(2000).optional(),
            }),
          )
          .min(1)
          .max(MAX_LOTE)
          .describe("Lista de eventos a criar"),
      },
      outputSchema: SaidaLote,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ eventos }) =>
      executar(async () => {
        const { criados, conflitos } = await criarEConferir(api, eventos);
        return sucesso(`Criados ${criados.length} eventos:\n${listarCompacto(criados)}\n${textoConflitos(conflitos)}`, {
          total: criados.length,
          eventos: criados,
          conflitos,
        });
      }),
  );

  server.registerTool(
    "remover_eventos_em_lote",
    {
      title: "Remover eventos em lote",
      description: [
        `Remove vários eventos de uma vez, permanentemente. Use para "cancela todos os jiu-jitsu", "limpa minha sexta".`,
        "SEMPRE use esta tool para remover 2 ou mais eventos, em vez de chamar remover_evento várias vezes: o usuário confirma uma vez só.",
        "Obtenha os ids com listar_eventos no período e filtre pelo que o usuário pediu. Atômico: se algum id não existir, nada é removido.",
      ].join("\n"),
      inputSchema: {
        ids: z.array(z.uuid()).min(1).max(MAX_LOTE).describe("ids (UUID) dos eventos a remover, de listar_eventos"),
      },
      outputSchema: { removidos: z.number().int() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ ids }) =>
      executar(async () => {
        const { removidos } = await api.removerVarios(ids);
        return sucesso(`${removidos} evento(s) removido(s).`, { removidos });
      }),
  );
}
