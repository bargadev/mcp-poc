import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  FunctionTool,
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseFunctionToolCall,
  ResponseInputItem,
} from "openai/resources/responses/responses";
import type { ContextoUsuario, EventoChat } from "./eventos.js";

/** Só o que o agente usa do SDK da OpenAI (facilita o mock nos testes). */
export type CriarResposta = (params: ResponseCreateParamsNonStreaming) => Promise<Pick<Response, "output" | "output_text">>;

export type ClienteMcp = Pick<Client, "callTool" | "listTools" | "getInstructions">;

export type Emitir = (evento: EventoChat) => void;

interface Ferramenta {
  definicao: FunctionTool;
  somenteLeitura: boolean;
  destrutiva: boolean;
}

export interface Conversa {
  id: string;
  itens: ResponseInputItem[];
  /** Chamada destrutiva aguardando o usuário confirmar ou cancelar. */
  pendente?: ResponseFunctionToolCall;
}

export interface OpcoesAgente {
  criarResposta: CriarResposta;
  mcp: ClienteMcp;
  modelo: string;
  esforco?: "minimal" | "low" | "medium" | "high";
  maxPassos?: number;
}

const MSG_CANCELADO =
  "O usuário clicou em Cancelar na confirmação: a ação NÃO foi executada e nada mudou na agenda. Diga isso em uma frase curta (ex: \"Ok, mantive o evento.\") e não tente de novo.";

/** Converte as tools do MCP para function tools da OpenAI, guardando as annotations. */
export async function carregarFerramentas(mcp: ClienteMcp): Promise<Map<string, Ferramenta>> {
  const { tools } = await mcp.listTools();
  return new Map(
    tools.map((t) => {
      const { $schema: _, ...parametros } = t.inputSchema as Record<string, unknown>;
      return [
        t.name,
        {
          definicao: {
            type: "function",
            name: t.name,
            description: t.description ?? t.title ?? t.name,
            parameters: parametros,
            strict: false,
          },
          somenteLeitura: t.annotations?.readOnlyHint === true,
          // Spec MCP: destructiveHint vale true por padrão quando a tool não é somente leitura.
          destrutiva: t.annotations?.readOnlyHint !== true && t.annotations?.destructiveHint !== false,
        } satisfies Ferramenta,
      ];
    }),
  );
}

export function montarInstrucoes(ctx: ContextoUsuario, instrucoesMcp?: string): string {
  const diaSemana = new Intl.DateTimeFormat("pt-BR", { weekday: "long", timeZone: ctx.fuso }).format(
    new Date(ctx.agora),
  );
  return `Você é o assistente da agenda pessoal do usuário e age usando as tools disponíveis.

Contexto atual: agora é ${ctx.agora} (${diaSemana}), fuso ${ctx.fuso}. Use isso para resolver datas relativas ("amanhã", "sexta", "semana que vem") e use esse offset nas datas que enviar às tools.

Regras:
- Responda em português do Brasil, curto e direto. Horários no formato "14h–15h" ou "9h30", datas como "sexta, 21/11".
- Não mostre ids nem JSON ao usuário; use os ids só para encadear tools.
- Para alterar ou remover, descubra o evento com listar_eventos. Se mais de um evento puder corresponder, pergunte qual.
- Antes de criar ou remarcar, verifique a disponibilidade e avise sobre conflitos.
- Vários eventos de uma vez: use criar_eventos_recorrentes (repetição semanal), criar_eventos_em_lote ou remover_eventos_em_lote, numa única chamada. Nunca chame criar_evento ou remover_evento repetidamente.
- Para remover, chame remover_evento normalmente: a interface pede a confirmação do usuário antes de executar.
- Se faltar informação essencial (ex: horário), pergunte em vez de inventar.
${instrucoesMcp ? `\nInstruções do servidor da agenda:\n${instrucoesMcp}` : ""}`;
}

function textoDoResultado(resultado: Awaited<ReturnType<ClienteMcp["callTool"]>>): string {
  const content = (resultado.content ?? []) as { type: string; text?: string }[];
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

function parseArgs(call: ResponseFunctionToolCall): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(call.arguments || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const fmtHora = (iso: string, fuso: string) =>
  new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: fuso }).format(new Date(iso));
const fmtDia = (iso: string, fuso: string) =>
  new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: fuso }).format(
    new Date(iso),
  );

export function criarAgente(opcoes: OpcoesAgente) {
  const { criarResposta, mcp, modelo, esforco, maxPassos = 20 } = opcoes;
  let ferramentas: Map<string, Ferramenta> | undefined;

  async function obterFerramentas() {
    ferramentas ??= await carregarFerramentas(mcp);
    return ferramentas;
  }

  async function executar(conv: Conversa, call: ResponseFunctionToolCall, emitir: Emitir) {
    const ferramenta = (await obterFerramentas()).get(call.name);
    const args = parseArgs(call);
    emitir({ tipo: "tool_call", callId: call.call_id, nome: call.name, args: args ?? {} });

    let texto: string;
    let isError: boolean;
    let dados: Record<string, unknown> | undefined;
    if (!ferramenta) {
      [texto, isError] = [`Tool desconhecida: ${call.name}.`, true];
    } else if (!args) {
      [texto, isError] = ["Os argumentos não são um JSON de objeto válido. Corrija e tente de novo.", true];
    } else {
      try {
        const r = await mcp.callTool({ name: call.name, arguments: args });
        texto = textoDoResultado(r);
        isError = r.isError === true;
        dados = r.structuredContent as Record<string, unknown> | undefined;
      } catch (e) {
        texto = `Falha ao chamar o servidor MCP da agenda: ${e instanceof Error ? e.message : String(e)}`;
        isError = true;
      }
    }

    conv.itens.push({
      type: "function_call_output",
      call_id: call.call_id,
      output: isError ? `ERRO: ${texto}` : texto,
    });
    emitir({
      tipo: "tool_result",
      callId: call.call_id,
      nome: call.name,
      isError,
      texto,
      dados,
      mutou: !isError && ferramenta?.somenteLeitura === false,
    });
  }

  /** Descreve a ação destrutiva com dados reais do evento (busca somente leitura). */
  async function resumirAcao(call: ResponseFunctionToolCall, ctx: ContextoUsuario): Promise<string> {
    const args = parseArgs(call) ?? {};
    if (call.name === "remover_evento" && typeof args.id === "string") {
      try {
        const r = await mcp.callTool({ name: "buscar_evento", arguments: { id: args.id } });
        const ev = (r.structuredContent as { evento?: { titulo: string; inicio: string; fim: string } } | undefined)
          ?.evento;
        if (!r.isError && ev) {
          return `Remover “${ev.titulo}” (${fmtDia(ev.inicio, ctx.fuso)}, ${fmtHora(ev.inicio, ctx.fuso)}–${fmtHora(ev.fim, ctx.fuso)})`;
        }
      } catch {
        // sem detalhes; cai no resumo genérico
      }
    }
    if (call.name === "remover_eventos_em_lote" && Array.isArray(args.ids)) {
      return resumirLote(args.ids.filter((x): x is string => typeof x === "string"), ctx);
    }
    return `Executar ${call.name}`;
  }

  /** "Remover 11 eventos: 11× “Jiu-jitsu” (seg., 30/11 → qua., 23/12)" */
  async function resumirLote(ids: string[], ctx: ContextoUsuario): Promise<string> {
    const eventos: { titulo: string; inicio: string }[] = [];
    for (let i = 0; i < ids.length; i += 20) {
      const parte = await Promise.all(
        ids.slice(i, i + 20).map(async (id) => {
          try {
            const r = await mcp.callTool({ name: "buscar_evento", arguments: { id } });
            return (r.structuredContent as { evento?: { titulo: string; inicio: string } } | undefined)?.evento;
          } catch {
            return undefined;
          }
        }),
      );
      eventos.push(...parte.filter((e): e is { titulo: string; inicio: string } => !!e));
    }
    const base = `Remover ${ids.length} evento(s)`;
    if (!eventos.length) return base;
    const contagem = new Map<string, number>();
    for (const e of eventos) contagem.set(e.titulo, (contagem.get(e.titulo) ?? 0) + 1);
    const titulos = [...contagem]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([t, n]) => `${n}× “${t}”`)
      .join(", ");
    const datas = eventos.map((e) => e.inicio).sort((a, b) => Date.parse(a) - Date.parse(b));
    const periodo =
      datas.length > 1 ? `${fmtDia(datas[0]!, ctx.fuso)} → ${fmtDia(datas.at(-1)!, ctx.fuso)}` : fmtDia(datas[0]!, ctx.fuso);
    const naoAchados = ids.length - eventos.length;
    return `${base}: ${titulos}${contagem.size > 4 ? ", …" : ""} (${periodo})${naoAchados ? ` · ${naoAchados} id(s) não encontrado(s)` : ""}`;
  }

  /** Roda o loop até o modelo responder em texto ou pedir uma ação que exige confirmação. */
  async function rodar(conv: Conversa, ctx: ContextoUsuario, emitir: Emitir) {
    const mapa = await obterFerramentas();
    const instructions = montarInstrucoes(ctx, mcp.getInstructions());

    for (let passo = 0; passo < maxPassos; passo++) {
      const resposta = await criarResposta({
        model: modelo,
        instructions,
        input: conv.itens,
        tools: [...mapa.values()].map((f) => f.definicao),
        parallel_tool_calls: false,
        ...(esforco ? { reasoning: { effort: esforco } } : {}),
      });
      conv.itens.push(...(resposta.output as ResponseInputItem[]));

      const chamadas = resposta.output.filter((i): i is ResponseFunctionToolCall => i.type === "function_call");
      if (chamadas.length === 0) {
        emitir({ tipo: "mensagem", texto: resposta.output_text || "(sem resposta)" });
        return;
      }

      for (const call of chamadas) {
        if (mapa.get(call.name)?.destrutiva) {
          conv.pendente = call;
          emitir({
            tipo: "confirmacao",
            callId: call.call_id,
            nome: call.name,
            args: parseArgs(call) ?? {},
            resumo: await resumirAcao(call, ctx),
          });
          return;
        }
        await executar(conv, call, emitir);
      }
    }
    emitir({
      tipo: "erro",
      mensagem: `Parei após ${maxPassos} passos sem terminar. O que já foi feito está salvo; diga "continue" para eu seguir.`,
    });
  }

  function cancelarPendente(conv: Conversa, emitir: Emitir) {
    const call = conv.pendente;
    if (!call) return;
    conv.pendente = undefined;
    conv.itens.push({ type: "function_call_output", call_id: call.call_id, output: MSG_CANCELADO });
    emitir({
      tipo: "tool_result",
      callId: call.call_id,
      nome: call.name,
      isError: false,
      texto: "Cancelado pelo usuário.",
      mutou: false,
      cancelada: true,
    });
  }

  return {
    async enviarMensagem(conv: Conversa, texto: string, ctx: ContextoUsuario, emitir: Emitir) {
      // Mensagem nova com confirmação pendente = o usuário desistiu da ação.
      cancelarPendente(conv, emitir);
      conv.itens.push({ role: "user", content: texto });
      await rodar(conv, ctx, emitir);
    },

    async confirmar(conv: Conversa, callId: string, aprovado: boolean, ctx: ContextoUsuario, emitir: Emitir) {
      const call = conv.pendente;
      if (!call || call.call_id !== callId) {
        emitir({ tipo: "erro", mensagem: "Não há ação pendente com esse id (talvez já tenha sido resolvida)." });
        return;
      }
      if (aprovado) {
        conv.pendente = undefined;
        await executar(conv, call, emitir);
      } else {
        cancelarPendente(conv, emitir);
      }
      await rodar(conv, ctx, emitir);
    },
  };
}

export type Agente = ReturnType<typeof criarAgente>;
