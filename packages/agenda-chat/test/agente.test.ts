import { buildApp } from "@agenda/api/app";
import { abrirDb, type Db } from "@agenda/api/db";
import { criarApiClient } from "@agenda/mcp/api-client";
import { createServer } from "@agenda/mcp/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  ResponseCreateParamsNonStreaming,
  ResponseInputItem,
  ResponseOutputItem,
} from "openai/resources/responses/responses";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { carregarFerramentas, criarAgente, type Conversa, type CriarResposta } from "../src/agente.js";
import { buildChatApp } from "../src/app.js";
import type { ContextoUsuario, EventoChat } from "../src/eventos.js";

// ---------------------------------------------------------------------------
// Infra: API real em memória (via app.inject) ← MCP real em memória ← agente
// ---------------------------------------------------------------------------

let db: Db;
let api: ReturnType<typeof buildApp>;
let mcp: Client;
let fecharMcp: () => Promise<void>;

const fetchNaApi: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const r = await api.inject({
    method: (init?.method ?? "GET") as "GET",
    url: url.pathname + url.search,
    payload: init?.body as string | undefined,
    headers: init?.headers as Record<string, string> | undefined,
  });
  return new Response(r.statusCode === 204 ? null : r.body, {
    status: r.statusCode,
    headers: { "content-type": String(r.headers["content-type"] ?? "application/json") },
  });
};

beforeEach(async () => {
  db = abrirDb(":memory:");
  api = buildApp({ db });
  const server = createServer({ api: criarApiClient({ baseUrl: "http://agenda.test", fetch: fetchNaApi }) });
  mcp = new Client({ name: "teste", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), mcp.connect(a)]);
  fecharMcp = async () => {
    await mcp.close();
    await server.close();
  };
});

afterEach(async () => {
  await fecharMcp();
  await api.close();
  db.close();
});

async function criarNaApi(titulo: string, inicio: string, fim: string) {
  const r = await api.inject({ method: "POST", url: "/eventos", payload: { titulo, inicio, fim } });
  return r.json() as { id: string; titulo: string };
}

async function titulosNaApi() {
  return ((await api.inject({ method: "GET", url: "/eventos" })).json() as { titulo: string }[]).map((e) => e.titulo);
}

// ---------------------------------------------------------------------------
// Modelo falso: roteiro de respostas, registrando cada request
// ---------------------------------------------------------------------------

type Passo = (params: ResponseCreateParamsNonStreaming) => { output: ResponseOutputItem[]; output_text: string };

let seq = 0;
const chamar = (name: string, args: Record<string, unknown>): Passo => () => ({
  output: [
    { type: "function_call", id: `fc_${++seq}`, call_id: `call_${seq}`, name, arguments: JSON.stringify(args), status: "completed" },
  ],
  output_text: "",
});
const responder = (texto: string): Passo => () => ({
  output: [
    {
      type: "message",
      id: `msg_${++seq}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: texto, annotations: [] }],
    } as ResponseOutputItem,
  ],
  output_text: texto,
});

function modeloFalso(...passos: Passo[]) {
  const requests: ResponseCreateParamsNonStreaming[] = [];
  const criarResposta: CriarResposta = async (params) => {
    requests.push(structuredClone(params));
    const passo = passos.shift();
    if (!passo) throw new Error("modelo falso sem mais passos");
    return passo(params);
  };
  return { criarResposta, requests };
}

const ctx: ContextoUsuario = { agora: "2026-11-19T10:00:00-03:00", fuso: "America/Sao_Paulo" };

function novaConversa(): Conversa {
  return { id: "c1", itens: [] };
}

function coletor() {
  const eventos: EventoChat[] = [];
  return { eventos, emitir: (e: EventoChat) => eventos.push(e), tipos: () => eventos.map((e) => e.tipo) };
}

const saidas = (itens: ResponseInputItem[]) =>
  itens.filter((i): i is ResponseInputItem.FunctionCallOutput => i.type === "function_call_output");

// ---------------------------------------------------------------------------

describe("carregarFerramentas", () => {
  it("converte as tools do MCP e respeita as annotations", async () => {
    const f = await carregarFerramentas(mcp);
    expect([...f.keys()].sort()).toEqual([
      "atualizar_evento",
      "buscar_evento",
      "criar_evento",
      "criar_eventos_em_lote",
      "criar_eventos_recorrentes",
      "listar_eventos",
      "remover_evento",
      "remover_eventos_em_lote",
      "verificar_disponibilidade",
    ]);
    expect(f.get("remover_evento")).toMatchObject({ destrutiva: true, somenteLeitura: false });
    expect(f.get("remover_eventos_em_lote")).toMatchObject({ destrutiva: true });
    expect(f.get("criar_eventos_recorrentes")).toMatchObject({ destrutiva: false, somenteLeitura: false });
    expect(f.get("criar_evento")).toMatchObject({ destrutiva: false, somenteLeitura: false });
    expect(f.get("listar_eventos")).toMatchObject({ destrutiva: false, somenteLeitura: true });
    const def = f.get("criar_evento")!.definicao;
    expect(def).toMatchObject({ type: "function", name: "criar_evento", strict: false });
    expect(def.parameters).not.toHaveProperty("$schema");
    expect(def.description).toContain("ISO 8601");
  });
});

describe("loop do agente", () => {
  it("leitura: chama a tool, devolve o resultado ao modelo e emite a resposta final", async () => {
    await criarNaApi("Daily", "2026-11-20T09:30:00-03:00", "2026-11-20T09:45:00-03:00");
    const m = modeloFalso(
      chamar("listar_eventos", { de: "2026-11-20T00:00:00-03:00", ate: "2026-11-21T00:00:00-03:00" }),
      responder("Amanhã você tem a Daily às 9h30."),
    );
    const agente = criarAgente({ criarResposta: m.criarResposta, mcp, modelo: "modelo-teste" });
    const conv = novaConversa();
    const c = coletor();

    await agente.enviarMensagem(conv, "o que tenho amanhã?", ctx, c.emitir);

    expect(c.tipos()).toEqual(["tool_call", "tool_result", "mensagem"]);
    expect(c.eventos[1]).toMatchObject({ nome: "listar_eventos", isError: false, mutou: false });
    expect(c.eventos[2]).toEqual({ tipo: "mensagem", texto: "Amanhã você tem a Daily às 9h30." });

    // 1ª request: contexto de data no system, tools, uma chamada por vez
    expect(m.requests[0]).toMatchObject({ model: "modelo-teste", parallel_tool_calls: false });
    expect(m.requests[0]!.instructions).toContain("2026-11-19T10:00:00-03:00");
    expect(m.requests[0]!.instructions).toContain("quinta-feira");
    expect(m.requests[0]!.tools).toHaveLength(9);
    // 2ª request: o resultado da tool (com id) volta ao modelo
    const [saida] = saidas(m.requests[1]!.input as ResponseInputItem[]);
    expect(saida!.output).toContain("Daily");
    expect(saida!.output).toMatch(/id [0-9a-f-]{36}/);
  });

  it("escrita: cria o evento na API e marca mutou=true", async () => {
    const m = modeloFalso(
      chamar("verificar_disponibilidade", { de: "2026-11-21T14:00:00-03:00", ate: "2026-11-21T15:00:00-03:00" }),
      chamar("criar_evento", {
        titulo: "Reunião",
        inicio: "2026-11-21T14:00:00-03:00",
        fim: "2026-11-21T15:00:00-03:00",
      }),
      responder("Marquei a reunião sexta das 14h às 15h."),
    );
    const agente = criarAgente({ criarResposta: m.criarResposta, mcp, modelo: "x" });
    const c = coletor();

    await agente.enviarMensagem(novaConversa(), "marca reunião sexta 14h às 15h", ctx, c.emitir);

    const resultados = c.eventos.filter((e) => e.tipo === "tool_result");
    expect(resultados.map((r) => [r.nome, r.mutou])).toEqual([
      ["verificar_disponibilidade", false],
      ["criar_evento", true],
    ]);
    expect((resultados[1]!.dados as { evento: { id: string } }).evento.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await titulosNaApi()).toEqual(["Reunião"]);
  });

  it("erro da tool volta ao modelo como ERRO e o loop continua", async () => {
    const m = modeloFalso(
      chamar("criar_evento", { titulo: "X", inicio: "2026-11-21T15:00:00-03:00", fim: "2026-11-21T14:00:00-03:00" }),
      responder("O fim precisa ser depois do início."),
    );
    const agente = criarAgente({ criarResposta: m.criarResposta, mcp, modelo: "x" });
    const c = coletor();
    await agente.enviarMensagem(novaConversa(), "marca X", ctx, c.emitir);

    expect(c.eventos[1]).toMatchObject({ tipo: "tool_result", isError: true, mutou: false });
    expect(saidas(m.requests[1]!.input as ResponseInputItem[])[0]!.output).toBe(
      "ERRO: Dados inválidos — fim: fim deve ser depois de inicio",
    );
    expect(await titulosNaApi()).toEqual([]);
  });

  it("argumentos que não são JSON viram erro para o modelo corrigir", async () => {
    const m = modeloFalso(
      () => ({
        output: [{ type: "function_call", call_id: "call_x", name: "listar_eventos", arguments: "{de:" }],
        output_text: "",
      }),
      responder("ok"),
    );
    const agente = criarAgente({ criarResposta: m.criarResposta, mcp, modelo: "x" });
    const c = coletor();
    await agente.enviarMensagem(novaConversa(), "?", ctx, c.emitir);
    expect(c.eventos[1]).toMatchObject({ tipo: "tool_result", isError: true });
    expect(saidas(m.requests[1]!.input as ResponseInputItem[])[0]!.output).toContain("JSON");
  });

  it("para após maxPassos se o modelo nunca responde em texto", async () => {
    const passos = Array.from({ length: 3 }, () =>
      chamar("listar_eventos", { de: "2026-11-20T00:00:00-03:00", ate: "2026-11-21T00:00:00-03:00" }),
    );
    const agente = criarAgente({ criarResposta: modeloFalso(...passos).criarResposta, mcp, modelo: "x", maxPassos: 3 });
    const c = coletor();
    await agente.enviarMensagem(novaConversa(), "?", ctx, c.emitir);
    expect(c.eventos.at(-1)).toMatchObject({ tipo: "erro" });
  });
});

describe("confirmação de ação destrutiva (destructiveHint)", () => {
  async function pedirRemocao() {
    const ev = await criarNaApi("Almoço com cliente", "2026-11-20T12:00:00-03:00", "2026-11-20T13:30:00-03:00");
    const m = modeloFalso(chamar("remover_evento", { id: ev.id }));
    const conv = novaConversa();
    const c = coletor();
    await criarAgente({ criarResposta: m.criarResposta, mcp, modelo: "x" }).enviarMensagem(
      conv,
      "cancela o almoço",
      ctx,
      c.emitir,
    );
    return { conv, c };
  }

  it("pausa antes de executar e descreve o evento real", async () => {
    const { conv, c } = await pedirRemocao();
    expect(c.tipos()).toEqual(["confirmacao"]);
    const conf = c.eventos[0] as Extract<EventoChat, { tipo: "confirmacao" }>;
    expect(conf.resumo).toBe("Remover “Almoço com cliente” (sex., 20/11, 12:00–13:30)");
    expect(conv.pendente?.call_id).toBe(conf.callId);
    expect(await titulosNaApi()).toEqual(["Almoço com cliente"]);
  });

  it("aprovado: executa, avisa que mudou e continua o loop", async () => {
    const { conv } = await pedirRemocao();
    const callId = conv.pendente!.call_id;
    const m2 = modeloFalso(responder("Pronto, removi o almoço."));
    const c2 = coletor();

    await criarAgente({ criarResposta: m2.criarResposta, mcp, modelo: "x" }).confirmar(conv, callId, true, ctx, c2.emitir);

    expect(c2.tipos()).toEqual(["tool_call", "tool_result", "mensagem"]);
    expect(c2.eventos[1]).toMatchObject({ nome: "remover_evento", mutou: true, isError: false });
    expect(await titulosNaApi()).toEqual([]);
    expect(conv.pendente).toBeUndefined();
  });

  it("cancelado: não executa e o modelo recebe o cancelamento", async () => {
    const { conv } = await pedirRemocao();
    const callId = conv.pendente!.call_id;
    const m2 = modeloFalso(responder("Ok, mantive o evento."));
    const c2 = coletor();
    await criarAgente({ criarResposta: m2.criarResposta, mcp, modelo: "x" }).confirmar(conv, callId, false, ctx, c2.emitir);

    expect(c2.eventos[0]).toMatchObject({ tipo: "tool_result", cancelada: true, mutou: false });
    expect(saidas(m2.requests[0]!.input as ResponseInputItem[]).at(-1)!.output).toContain("NÃO foi executada");
    expect(await titulosNaApi()).toEqual(["Almoço com cliente"]);
  });

  it("mensagem nova com confirmação pendente cancela a ação", async () => {
    const { conv } = await pedirRemocao();
    const m2 = modeloFalso(responder("Certo."));
    const c2 = coletor();
    await criarAgente({ criarResposta: m2.criarResposta, mcp, modelo: "x" }).enviarMensagem(conv, "deixa pra lá", ctx, c2.emitir);

    expect(c2.tipos()).toEqual(["tool_result", "mensagem"]);
    expect(conv.pendente).toBeUndefined();
    expect(await titulosNaApi()).toEqual(["Almoço com cliente"]);
  });

  it("confirmar com callId errado não executa nada", async () => {
    const { conv } = await pedirRemocao();
    const c2 = coletor();
    await criarAgente({ criarResposta: modeloFalso().criarResposta, mcp, modelo: "x" }).confirmar(conv, "outro", true, ctx, c2.emitir);
    expect(c2.tipos()).toEqual(["erro"]);
    expect(await titulosNaApi()).toEqual(["Almoço com cliente"]);
  });
});

describe("lote (o caso que travava: recorrência criada evento a evento)", () => {
  it("recorrência: uma única tool call cria a série inteira e o loop termina", async () => {
    const m = modeloFalso(
      chamar("criar_eventos_recorrentes", {
        titulo: "Jiu-jitsu",
        diasDaSemana: ["seg", "qua", "sex"],
        horaInicio: "19:30",
        horaFim: "20:30",
        de: "2026-11-20",
        ate: "2026-12-31",
      }),
      responder("Criei 18 aulas de jiu-jitsu até 31/12."),
    );
    const c = coletor();
    await criarAgente({ criarResposta: m.criarResposta, mcp, modelo: "x" }).enviarMensagem(
      novaConversa(),
      "jiu-jitsu seg/qua/sex 19h30 até o fim do ano",
      ctx,
      c.emitir,
    );
    expect(c.tipos()).toEqual(["tool_call", "tool_result", "mensagem"]);
    expect(c.eventos[1]).toMatchObject({ mutou: true, isError: false, dados: { total: 18 } });
    expect(await titulosNaApi()).toHaveLength(18);
    expect(m.requests).toHaveLength(2);
  });

  it("remoção em lote: uma confirmação com o resumo de todos", async () => {
    const r = await api.inject({
      method: "POST",
      url: "/eventos/lote",
      payload: {
        eventos: ["2026-11-23", "2026-11-25", "2026-11-27"].map((d) => ({
          titulo: "Jiu-jitsu",
          inicio: `${d}T19:30:00-03:00`,
          fim: `${d}T20:30:00-03:00`,
        })),
      },
    });
    const ids = (r.json().eventos as { id: string }[]).map((e) => e.id);
    const conv = novaConversa();
    const c = coletor();
    await criarAgente({ criarResposta: modeloFalso(chamar("remover_eventos_em_lote", { ids })).criarResposta, mcp, modelo: "x" })
      .enviarMensagem(conv, "cancela todos os jiu-jitsu", ctx, c.emitir);

    expect(c.tipos()).toEqual(["confirmacao"]);
    expect((c.eventos[0] as { resumo: string }).resumo).toBe("Remover 3 evento(s): 3× “Jiu-jitsu” (seg., 23/11 → sex., 27/11)");
    expect(await titulosNaApi()).toHaveLength(3);

    const c2 = coletor();
    await criarAgente({ criarResposta: modeloFalso(responder("Removidos.")).criarResposta, mcp, modelo: "x" }).confirmar(
      conv,
      conv.pendente!.call_id,
      true,
      ctx,
      c2.emitir,
    );
    expect(c2.eventos[1]).toMatchObject({ tipo: "tool_result", mutou: true, dados: { removidos: 3 } });
    expect(await titulosNaApi()).toEqual([]);
  });
});

describe("HTTP /chat (SSE)", () => {
  function parseSse(body: string): EventoChat[] {
    return body
      .split("\n\n")
      .filter((b) => b.startsWith("data: "))
      .map((b) => JSON.parse(b.slice(6)) as EventoChat);
  }

  it("streama inicio → eventos → fim e reaproveita a conversa", async () => {
    const m = modeloFalso(responder("Oi!"), responder("De novo!"));
    const app = buildChatApp({ agente: criarAgente({ criarResposta: m.criarResposta, mcp, modelo: "x" }) });
    const r1 = await app.inject({ method: "POST", url: "/chat", payload: { texto: "oi", ...ctx } });
    expect(r1.headers["content-type"]).toContain("text/event-stream");
    const ev1 = parseSse(r1.body);
    expect(ev1.map((e) => e.tipo)).toEqual(["inicio", "mensagem", "fim"]);
    const conversaId = (ev1[0] as { conversaId: string }).conversaId;

    const r2 = await app.inject({ method: "POST", url: "/chat", payload: { conversaId, texto: "de novo", ...ctx } });
    expect(parseSse(r2.body)[0]).toEqual({ tipo: "inicio", conversaId });
    // histórico acumulado: 2ª request ao modelo contém a 1ª pergunta
    expect(JSON.stringify(m.requests[1]!.input)).toContain("oi");
    await app.close();
  });

  it("erro da OpenAI vira evento de erro legível, sem stack", async () => {
    const criarResposta: CriarResposta = async () => {
      throw Object.assign(new Error("Incorrect API key"), { status: 401 });
    };
    const app = buildChatApp({ agente: criarAgente({ criarResposta, mcp, modelo: "x" }) });
    app.log.level = "silent";
    const r = await app.inject({ method: "POST", url: "/chat", payload: { texto: "oi", ...ctx } });
    expect(parseSse(r.body)).toContainEqual({
      tipo: "erro",
      mensagem: "A chave da OpenAI foi recusada (401). Verifique OPENAI_API_KEY / OPENAI_ENV_FILE.",
    });
    await app.close();
  });

  it("400 para body inválido", async () => {
    const app = buildChatApp({ agente: criarAgente({ criarResposta: modeloFalso().criarResposta, mcp, modelo: "x" }) });
    const r = await app.inject({ method: "POST", url: "/chat", payload: { texto: "" } });
    expect(r.statusCode).toBe(400);
    await app.close();
  });
});
