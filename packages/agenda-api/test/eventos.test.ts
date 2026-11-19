import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { abrirDb, type Db } from "../src/db.js";
import { EventoSchema, type Evento } from "../src/schemas.js";

let db: Db;
let app: ReturnType<typeof buildApp>;

beforeEach(() => {
  db = abrirDb(":memory:");
  app = buildApp({ db });
});

afterEach(async () => {
  await app.close();
  db.close();
});

const reuniao = {
  titulo: "Reunião de planejamento",
  descricao: "Sprint 42",
  inicio: "2026-11-20T14:00:00-03:00",
  fim: "2026-11-20T15:00:00-03:00",
};

async function criar(body: Record<string, unknown> = reuniao): Promise<Evento> {
  const res = await app.inject({ method: "POST", url: "/eventos", payload: body });
  expect(res.statusCode).toBe(201);
  return res.json();
}

const UUID_INEXISTENTE = "00000000-0000-4000-8000-000000000000";

describe("POST /eventos", () => {
  it("cria evento válido e preserva o offset das datas", async () => {
    const ev = await criar();
    expect(EventoSchema.parse(ev)).toEqual(ev);
    expect(ev).toMatchObject(reuniao);
    expect(ev.criadoEm).toBe(ev.atualizadoEm);
  });

  it("descricao é opcional (retorna null)", async () => {
    const { descricao: _, ...semDescricao } = reuniao;
    const ev = await criar(semDescricao);
    expect(ev.descricao).toBeNull();
  });

  it("400 quando fim é antes do início", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/eventos",
      payload: { ...reuniao, inicio: reuniao.fim, fim: reuniao.inicio },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      erro: "Dados inválidos — fim: fim deve ser depois de inicio",
      detalhes: [{ campo: "fim", mensagem: "fim deve ser depois de inicio" }],
    });
  });

  it("400 quando fim é igual ao início", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/eventos",
      payload: { ...reuniao, fim: reuniao.inicio },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400 legível para data sem timezone, campo faltando e campo desconhecido", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/eventos",
      payload: { inicio: "2026-11-20T14:00:00", fim: reuniao.fim, local: "sala 1" },
    });
    expect(res.statusCode).toBe(400);
    const corpo = res.json();
    expect(corpo.detalhes).toEqual(
      expect.arrayContaining([
        { campo: "titulo", mensagem: "campo obrigatório" },
        {
          campo: "inicio",
          mensagem: "deve estar em ISO 8601 com timezone, ex: 2026-11-20T15:00:00-03:00",
        },
        { campo: "(corpo)", mensagem: "campo(s) desconhecido(s): local" },
      ]),
    );
    expect(corpo.erro).toMatch(/^Dados inválidos — /);
  });

  it("400 para JSON malformado sem stack trace", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/eventos",
      headers: { "content-type": "application/json" },
      payload: "{titulo:",
    });
    expect(res.statusCode).toBe(400);
    expect(Object.keys(res.json())).toEqual(["erro"]);
    expect(res.body).not.toMatch(/at .*\.js/);
  });
});

describe("GET /eventos/:id", () => {
  it("retorna o evento", async () => {
    const ev = await criar();
    const res = await app.inject({ method: "GET", url: `/eventos/${ev.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(ev);
  });

  it("404 para evento inexistente", async () => {
    const res = await app.inject({ method: "GET", url: `/eventos/${UUID_INEXISTENTE}` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ erro: `Evento não encontrado com id ${UUID_INEXISTENTE}` });
  });

  it("400 para id que não é UUID", async () => {
    const res = await app.inject({ method: "GET", url: "/eventos/abc" });
    expect(res.statusCode).toBe(400);
    expect(res.json().detalhes).toEqual([{ campo: "id", mensagem: "deve ser um UUID" }]);
  });
});

describe("GET /eventos?de=&ate= (sobreposição / conflito de horário)", () => {
  async function listar(de: string, ate: string) {
    const res = await app.inject({ method: "GET", url: "/eventos", query: { de, ate } });
    expect(res.statusCode).toBe(200);
    return (res.json() as Evento[]).map((e) => e.titulo);
  }

  beforeEach(async () => {
    await criar({ titulo: "A 14-15", inicio: "2026-11-20T14:00:00-03:00", fim: "2026-11-20T15:00:00-03:00" });
    await criar({ titulo: "B 16-17", inicio: "2026-11-20T16:00:00-03:00", fim: "2026-11-20T17:00:00-03:00" });
    // 17h-18h em -03:00, enviado em UTC
    await criar({ titulo: "C 17-18 (UTC)", inicio: "2026-11-20T20:00:00Z", fim: "2026-11-20T21:00:00Z" });
  });

  it("retorna eventos que se sobrepõem parcialmente ao intervalo", async () => {
    expect(await listar("2026-11-20T14:30:00-03:00", "2026-11-20T16:30:00-03:00")).toEqual([
      "A 14-15",
      "B 16-17",
    ]);
  });

  it("compara instantes, não strings (timezones diferentes)", async () => {
    // 17:00Z == 14:00-03:00 → bate com A, gravado em -03:00
    expect(await listar("2026-11-20T17:00:00Z", "2026-11-20T17:30:00Z")).toEqual(["A 14-15"]);
    // C foi gravado em UTC e é encontrado consultando em -03:00
    expect(await listar("2026-11-20T17:30:00-03:00", "2026-11-20T18:30:00-03:00")).toEqual(["C 17-18 (UTC)"]);
  });

  it("intervalo encostado na borda não conflita (semiaberto)", async () => {
    expect(await listar("2026-11-20T15:00:00-03:00", "2026-11-20T16:00:00-03:00")).toEqual([]);
  });

  it("intervalo que contém o evento inteiro", async () => {
    expect(await listar("2026-11-20T00:00:00-03:00", "2026-11-21T00:00:00-03:00")).toHaveLength(3);
  });

  it("sem filtros lista tudo ordenado por início", async () => {
    const res = await app.inject({ method: "GET", url: "/eventos" });
    expect((res.json() as Evento[]).map((e) => e.titulo)).toEqual(["A 14-15", "B 16-17", "C 17-18 (UTC)"]);
  });

  it("400 quando ate é antes de de", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/eventos",
      query: { de: "2026-11-20T15:00:00-03:00", ate: "2026-11-20T14:00:00-03:00" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().erro).toBe("Dados inválidos — ate: ate deve ser depois de de");
  });
});

describe("PATCH /eventos/:id", () => {
  it("atualiza parcialmente e muda atualizadoEm", async () => {
    const ev = await criar();
    await new Promise((r) => setTimeout(r, 5));
    const res = await app.inject({
      method: "PATCH",
      url: `/eventos/${ev.id}`,
      payload: { titulo: "Planejamento (remarcado)", fim: "2026-11-20T15:30:00-03:00" },
    });
    expect(res.statusCode).toBe(200);
    const novo: Evento = res.json();
    expect(novo).toMatchObject({
      id: ev.id,
      titulo: "Planejamento (remarcado)",
      descricao: "Sprint 42",
      inicio: reuniao.inicio,
      fim: "2026-11-20T15:30:00-03:00",
      criadoEm: ev.criadoEm,
    });
    expect(novo.atualizadoEm > ev.atualizadoEm).toBe(true);
  });

  it("descricao: null limpa o campo", async () => {
    const ev = await criar();
    const res = await app.inject({ method: "PATCH", url: `/eventos/${ev.id}`, payload: { descricao: null } });
    expect(res.json().descricao).toBeNull();
  });

  it("400 quando o resultado do merge deixa fim antes do início", async () => {
    const ev = await criar();
    const res = await app.inject({
      method: "PATCH",
      url: `/eventos/${ev.id}`,
      payload: { inicio: "2026-11-20T16:00:00-03:00" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().erro).toContain("fim deve ser depois de inicio");
  });

  it("400 para body vazio", async () => {
    const ev = await criar();
    const res = await app.inject({ method: "PATCH", url: `/eventos/${ev.id}`, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().erro).toContain("informe ao menos um campo");
  });

  it("404 para evento inexistente", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/eventos/${UUID_INEXISTENTE}`,
      payload: { titulo: "x" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().erro).toBe(`Evento não encontrado com id ${UUID_INEXISTENTE}`);
  });
});

describe("DELETE /eventos/:id", () => {
  it("remove e depois retorna 404", async () => {
    const ev = await criar();
    expect((await app.inject({ method: "DELETE", url: `/eventos/${ev.id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/eventos/${ev.id}` })).statusCode).toBe(404);
  });

  it("404 para evento inexistente", async () => {
    const res = await app.inject({ method: "DELETE", url: `/eventos/${UUID_INEXISTENTE}` });
    expect(res.statusCode).toBe(404);
  });
});

describe("lote", () => {
  const ev = (dia: number, titulo = "Jiu-jitsu") => ({
    titulo,
    inicio: `2026-12-${String(dia).padStart(2, "0")}T19:30:00-03:00`,
    fim: `2026-12-${String(dia).padStart(2, "0")}T20:30:00-03:00`,
  });

  it("POST /eventos/lote cria todos e devolve os ids", async () => {
    const res = await app.inject({ method: "POST", url: "/eventos/lote", payload: { eventos: [ev(1), ev(3), ev(5)] } });
    expect(res.statusCode).toBe(201);
    const { eventos } = res.json() as { eventos: Evento[] };
    expect(eventos).toHaveLength(3);
    expect(new Set(eventos.map((e) => e.id)).size).toBe(3);
    const lista = await app.inject({ method: "GET", url: "/eventos" });
    expect(lista.json()).toHaveLength(3);
  });

  it("POST /eventos/lote é atômico: um item inválido → 400 com o índice e nada criado", async () => {
    const ruim = { ...ev(3), fim: ev(3).inicio };
    const res = await app.inject({ method: "POST", url: "/eventos/lote", payload: { eventos: [ev(1), ruim] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().detalhes).toEqual([{ campo: "eventos.1.fim", mensagem: "fim deve ser depois de inicio" }]);
    expect((await app.inject({ method: "GET", url: "/eventos" })).json()).toEqual([]);
  });

  it("POST /eventos/lote rejeita lista vazia", async () => {
    const res = await app.inject({ method: "POST", url: "/eventos/lote", payload: { eventos: [] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().erro).toContain("informe ao menos 1 evento");
  });

  it("POST /eventos/lote/remover remove todos", async () => {
    const criados = (
      await app.inject({ method: "POST", url: "/eventos/lote", payload: { eventos: [ev(1), ev(3), ev(5, "Outro")] } })
    ).json().eventos as Evento[];
    const ids = criados.filter((e) => e.titulo === "Jiu-jitsu").map((e) => e.id);
    const res = await app.inject({ method: "POST", url: "/eventos/lote/remover", payload: { ids } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removidos: 2 });
    expect(((await app.inject({ method: "GET", url: "/eventos" })).json() as Evento[]).map((e) => e.titulo)).toEqual([
      "Outro",
    ]);
  });

  it("POST /eventos/lote/remover é atômico: id inexistente → 404 e nada removido", async () => {
    const [a] = (await app.inject({ method: "POST", url: "/eventos/lote", payload: { eventos: [ev(1)] } })).json()
      .eventos as Evento[];
    const res = await app.inject({
      method: "POST",
      url: "/eventos/lote/remover",
      payload: { ids: [a!.id, UUID_INEXISTENTE] },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().erro).toBe(
      `Nenhum evento foi removido: 1 id(s) não encontrado(s): ${UUID_INEXISTENTE}`,
    );
    expect((await app.inject({ method: "GET", url: "/eventos" })).json()).toHaveLength(1);
  });
});
