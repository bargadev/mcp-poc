import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Evento } from "@agenda/api/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { criarApiClient } from "../src/api-client.js";
import { createServer } from "../src/server.js";

// ---------------------------------------------------------------------------
// API mockada: fetch falso que delega para um handler por teste
// ---------------------------------------------------------------------------

interface Req {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}
type Resp = { status: number; body?: unknown };

function mockFetch(handler: (req: Req) => Resp | Promise<Resp>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const req: Req = {
      method: init?.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    const { status, body } = await handler(req);
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
    });
  });
}

let fechar: (() => Promise<void>) | undefined;
afterEach(async () => {
  await fechar?.();
  fechar = undefined;
});

async function conectar(fetchFalso: typeof fetch) {
  const server = createServer({
    api: criarApiClient({ baseUrl: "http://agenda.test", fetch: fetchFalso }),
  });
  const client = new Client({ name: "teste", version: "0.0.0" });
  const [ladoCliente, ladoServidor] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(ladoServidor), client.connect(ladoCliente)]);
  fechar = async () => {
    await client.close();
    await server.close();
  };
  return client;
}

async function chamar(client: Client, name: string, args: Record<string, unknown>) {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

const texto = (r: CallToolResult) =>
  r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const evento = (over: Partial<Evento> = {}): Evento => ({
  id: "11111111-1111-4111-8111-111111111111",
  titulo: "Reunião de planejamento",
  descricao: null,
  inicio: "2026-11-20T14:00:00-03:00",
  fim: "2026-11-20T15:00:00-03:00",
  criadoEm: "2026-11-19T12:00:00.000Z",
  atualizadoEm: "2026-11-19T12:00:00.000Z",
  ...over,
});

const outro = evento({
  id: "22222222-2222-4222-8222-222222222222",
  titulo: "1:1 com gestor",
  inicio: "2026-11-20T14:30:00-03:00",
  fim: "2026-11-20T15:30:00-03:00",
});

const ID_INEXISTENTE = "00000000-0000-4000-8000-000000000000";

// ---------------------------------------------------------------------------

describe("catálogo de tools", () => {
  it("expõe as 9 tools com annotations e descriptions corretas", async () => {
    const client = await conectar(mockFetch(() => ({ status: 500 })));
    const { tools } = await client.listTools();
    const porNome = Object.fromEntries(tools.map((t) => [t.name, t]));

    expect(Object.keys(porNome).sort()).toEqual([
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
    expect(porNome.remover_eventos_em_lote!.annotations?.destructiveHint).toBe(true);
    expect(porNome.criar_eventos_recorrentes!.annotations?.destructiveHint).toBe(false);
    expect(porNome.criar_eventos_em_lote!.annotations?.destructiveHint).toBe(false);

    for (const nome of ["listar_eventos", "buscar_evento", "verificar_disponibilidade"]) {
      expect(porNome[nome]!.annotations?.readOnlyHint, nome).toBe(true);
    }
    for (const nome of ["criar_evento", "atualizar_evento", "remover_evento"]) {
      expect(porNome[nome]!.annotations?.readOnlyHint, nome).toBe(false);
    }
    expect(porNome.remover_evento!.annotations?.destructiveHint).toBe(true);
    expect(porNome.criar_evento!.annotations?.destructiveHint).toBe(false);

    for (const nome of ["listar_eventos", "criar_evento", "atualizar_evento", "verificar_disponibilidade"]) {
      expect(porNome[nome]!.description, nome).toContain("2026-11-20T15:00:00-03:00");
    }
    for (const t of tools) expect(t.outputSchema, t.name).toBeDefined();
  });
});

describe("criar_evento", () => {
  it("criação válida: envia o body à API e retorna o id", async () => {
    const criado = evento();
    const f = mockFetch((req) => {
      if (req.method === "POST") return { status: 201, body: criado };
      return { status: 200, body: [criado] }; // checagem de conflito encontra só ele mesmo
    });
    const client = await conectar(f);

    const r = await chamar(client, "criar_evento", {
      titulo: criado.titulo,
      inicio: criado.inicio,
      fim: criado.fim,
    });

    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ evento: criado, conflitos: [] });
    expect(texto(r)).toContain(`id ${criado.id}`);
    expect(texto(r)).toContain("Sem conflitos");

    const [post, get] = f.mock.calls.map(([url, init]) => ({ url: String(url), init }));
    expect(post!.url).toBe("http://agenda.test/eventos");
    expect(JSON.parse(String(post!.init?.body))).toEqual({
      titulo: criado.titulo,
      inicio: criado.inicio,
      fim: criado.fim,
    });
    expect(get!.url).toBe(
      `http://agenda.test/eventos?de=${encodeURIComponent(criado.inicio)}&ate=${encodeURIComponent(criado.fim)}`,
    );
  });

  it("conflito de horário: cria e devolve os eventos conflitantes com id", async () => {
    const criado = evento();
    const client = await conectar(
      mockFetch((req) =>
        req.method === "POST" ? { status: 201, body: criado } : { status: 200, body: [criado, outro] },
      ),
    );

    const r = await chamar(client, "criar_evento", {
      titulo: criado.titulo,
      inicio: criado.inicio,
      fim: criado.fim,
    });

    expect(r.isError).toBeFalsy();
    expect(r.structuredContent?.conflitos).toEqual([
      { id: outro.id, titulo: outro.titulo, inicio: outro.inicio, fim: outro.fim },
    ]);
    expect(texto(r)).toContain("ATENÇÃO: conflita com 1 evento(s)");
    expect(texto(r)).toContain(outro.id);
  });

  it("fim antes do início: erro da API vira isError com a mensagem dela, sem stack trace", async () => {
    const msg = "Dados inválidos — fim: fim deve ser depois de inicio";
    const client = await conectar(
      mockFetch(() => ({
        status: 400,
        body: { erro: msg, detalhes: [{ campo: "fim", mensagem: "fim deve ser depois de inicio" }] },
      })),
    );

    const r = await chamar(client, "criar_evento", {
      titulo: "x",
      inicio: "2026-11-20T15:00:00-03:00",
      fim: "2026-11-20T14:00:00-03:00",
    });

    expect(r.isError).toBe(true);
    expect(texto(r)).toBe(msg);
    expect(texto(r)).not.toMatch(/\n\s+at /);
  });

  it("data sem timezone é rejeitada antes de chamar a API", async () => {
    const f = mockFetch(() => ({ status: 201, body: evento() }));
    const client = await conectar(f);

    const r = await chamar(client, "criar_evento", {
      titulo: "x",
      inicio: "2026-11-20T14:00:00",
      fim: "2026-11-20T15:00:00-03:00",
    });

    expect(r.isError).toBe(true);
    expect(texto(r)).toContain("ISO 8601 com timezone");
    expect(f).not.toHaveBeenCalled();
  });
});

describe("evento inexistente", () => {
  const api404 = () =>
    mockFetch((req) => ({
      status: 404,
      body: { erro: `Evento não encontrado com id ${req.path.split("/").pop()}` },
    }));

  it("buscar_evento → isError com mensagem útil", async () => {
    const client = await conectar(api404());
    const r = await chamar(client, "buscar_evento", { id: ID_INEXISTENTE });
    expect(r.isError).toBe(true);
    expect(texto(r)).toBe(
      `Evento não encontrado com id ${ID_INEXISTENTE}. Use listar_eventos para encontrar o id correto.`,
    );
  });

  it("atualizar_evento → isError", async () => {
    const client = await conectar(api404());
    const r = await chamar(client, "atualizar_evento", { id: ID_INEXISTENTE, titulo: "novo" });
    expect(r.isError).toBe(true);
    expect(texto(r)).toContain(`Evento não encontrado com id ${ID_INEXISTENTE}`);
  });

  it("remover_evento → isError e não chama DELETE", async () => {
    const f = api404();
    const client = await conectar(f);
    const r = await chamar(client, "remover_evento", { id: ID_INEXISTENTE });
    expect(r.isError).toBe(true);
    expect(texto(r)).toContain(`Evento não encontrado com id ${ID_INEXISTENTE}`);
    expect(f.mock.calls.map(([, init]) => init?.method)).toEqual(["GET"]);
  });

  it("id que não é UUID → isError orientando a usar listar_eventos", async () => {
    const f = api404();
    const client = await conectar(f);
    const r = await chamar(client, "buscar_evento", { id: "reuniao-de-quinta" });
    expect(r.isError).toBe(true);
    expect(texto(r)).toContain("use listar_eventos");
    expect(f).not.toHaveBeenCalled();
  });
});

describe("verificar_disponibilidade", () => {
  const de = "2026-11-20T14:00:00-03:00";
  const ate = "2026-11-20T15:00:00-03:00";

  it("intervalo livre", async () => {
    const f = mockFetch(() => ({ status: 200, body: [] }));
    const client = await conectar(f);
    const r = await chamar(client, "verificar_disponibilidade", { de, ate });
    expect(r.structuredContent).toEqual({ livre: true, de, ate, conflitos: [] });
    expect(texto(r)).toMatch(/^Livre/);
  });

  it("conflito de horário: livre=false e lista conflitos com id", async () => {
    const f = mockFetch((req) => {
      expect(req.query).toEqual({ de, ate });
      return { status: 200, body: [evento(), outro] };
    });
    const client = await conectar(f);
    const r = await chamar(client, "verificar_disponibilidade", { de, ate });
    expect(r.structuredContent?.livre).toBe(false);
    expect((r.structuredContent?.conflitos as { id: string }[]).map((c) => c.id)).toEqual([
      evento().id,
      outro.id,
    ]);
    expect(texto(r)).toContain("Ocupado: 2 conflito(s)");
  });
});

describe("listar_eventos / atualizar_evento / remover_evento", () => {
  it("listar_eventos repassa o intervalo e devolve ids", async () => {
    const de = "2026-11-20T00:00:00-03:00";
    const ate = "2026-11-21T00:00:00-03:00";
    const f = mockFetch((req) => {
      expect(req).toMatchObject({ method: "GET", path: "/eventos", query: { de, ate } });
      return { status: 200, body: [evento(), outro] };
    });
    const client = await conectar(f);
    const r = await chamar(client, "listar_eventos", { de, ate });
    expect(r.structuredContent).toMatchObject({ de, ate, total: 2 });
    expect(texto(r)).toContain(`id ${evento().id}`);
    expect(texto(r)).toContain(`id ${outro.id}`);
  });

  it("atualizar_evento envia só os campos informados", async () => {
    const atualizado = evento({ titulo: "Planejamento (remarcado)" });
    const f = mockFetch((req) => {
      if (req.method === "PATCH") {
        expect(req.path).toBe(`/eventos/${atualizado.id}`);
        expect(req.body).toEqual({ titulo: atualizado.titulo, descricao: null });
        return { status: 200, body: atualizado };
      }
      return { status: 200, body: [atualizado] };
    });
    const client = await conectar(f);
    const r = await chamar(client, "atualizar_evento", {
      id: atualizado.id,
      titulo: atualizado.titulo,
      descricao: null,
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ evento: atualizado, conflitos: [] });
  });

  it("atualizar_evento sem campos → isError sem chamar a API", async () => {
    const f = mockFetch(() => ({ status: 200, body: evento() }));
    const client = await conectar(f);
    const r = await chamar(client, "atualizar_evento", { id: evento().id });
    expect(r.isError).toBe(true);
    expect(texto(r)).toContain("Informe ao menos um campo");
    expect(f).not.toHaveBeenCalled();
  });

  it("remover_evento busca, remove e devolve os dados do evento removido", async () => {
    const ev = evento();
    const f = mockFetch((req) =>
      req.method === "DELETE" ? { status: 204 } : { status: 200, body: ev },
    );
    const client = await conectar(f);
    const r = await chamar(client, "remover_evento", { id: ev.id });
    expect(r.structuredContent).toEqual({ removido: true, evento: ev });
    expect(f.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "DELETE"]);
  });
});

describe("falhas de infraestrutura", () => {
  it("404 sem corpo (URL apontando para outro serviço) → isError orientando a checar AGENDA_API_URL", async () => {
    const client = await conectar(mockFetch(() => ({ status: 404 })));
    const r = await chamar(client, "buscar_evento", { id: ID_INEXISTENTE });
    expect(r.isError).toBe(true);
    expect(texto(r)).toBe(
      `A API em http://agenda.test respondeu 404 para GET /eventos/${ID_INEXISTENTE} sem mensagem de erro. Verifique se AGENDA_API_URL aponta para a API de agenda.`,
    );
  });

  it("API fora do ar → isError com instrução de como resolver", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const client = await conectar(f);
    const r = await chamar(client, "listar_eventos", {
      de: "2026-11-20T00:00:00-03:00",
      ate: "2026-11-21T00:00:00-03:00",
    });
    expect(r.isError).toBe(true);
    expect(texto(r)).toContain("Não foi possível conectar à API de agenda em http://agenda.test");
    expect(texto(r)).toContain("pnpm dev:api");
  });
});

describe("lote", () => {
  /** API falsa: POST /eventos/lote ecoa com ids; GET /eventos devolve criados + `existentes`. */
  function apiDeLote(existentes: Evento[] = []) {
    let criados: Evento[] = [];
    return mockFetch((req) => {
      if (req.method === "POST" && req.path === "/eventos/lote") {
        const { eventos } = req.body as { eventos: Omit<Evento, "id" | "criadoEm" | "atualizadoEm">[] };
        criados = eventos.map((e, i) =>
          evento({ ...e, descricao: e.descricao ?? null, id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}` }),
        );
        return { status: 201, body: { eventos: criados } };
      }
      if (req.method === "GET" && req.path === "/eventos") return { status: 200, body: [...existentes, ...criados] };
      if (req.method === "POST" && req.path === "/eventos/lote/remover") {
        return { status: 200, body: { removidos: (req.body as { ids: string[] }).ids.length } };
      }
      return { status: 500 };
    });
  }

  const jiuJitsu = {
    titulo: "Jiu-jitsu",
    diasDaSemana: ["seg", "qua", "sex"],
    horaInicio: "19:30",
    horaFim: "20:30",
    de: "2026-11-20",
    ate: "2026-12-31",
  };

  it("criar_eventos_recorrentes: expande a regra numa única chamada à API", async () => {
    const conflitante = evento({
      id: "bbbbbbbb-0000-4000-8000-000000000000",
      titulo: "Aniversário",
      inicio: "2026-11-25T19:00:00-03:00",
      fim: "2026-11-25T20:00:00-03:00",
    });
    const f = apiDeLote([conflitante]);
    const client = await conectar(f);

    const r = await chamar(client, "criar_eventos_recorrentes", jiuJitsu);

    expect(r.isError).toBeFalsy();
    const posts = f.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    const enviados = JSON.parse(String(posts[0]![1]!.body)).eventos as { inicio: string; fim: string }[];
    // seg/qua/sex de 20/11 a 31/12/2026: 5 em novembro + 13 em dezembro
    expect(enviados).toHaveLength(18);
    expect(enviados[0]).toMatchObject({ inicio: "2026-11-20T19:30:00-03:00", fim: "2026-11-20T20:30:00-03:00" });
    expect(enviados[1]!.inicio).toBe("2026-11-23T19:30:00-03:00");
    expect(enviados.at(-1)!.inicio).toBe("2026-12-30T19:30:00-03:00");

    expect(r.structuredContent?.total).toBe(18);
    const conflitos = r.structuredContent?.conflitos as { ocorrencia: { inicio: string }; existente: { titulo: string } }[];
    expect(conflitos).toHaveLength(1);
    expect(conflitos[0]).toMatchObject({
      ocorrencia: { inicio: "2026-11-25T19:30:00-03:00" },
      existente: { titulo: "Aniversário" },
    });
    expect(texto(r)).toContain('Criados 18 eventos "Jiu-jitsu" (seg/qua/sex 19:30–20:30, de 2026-11-20 a 2026-12-31)');
    expect(texto(r)).toContain("ATENÇÃO: 1 conflito(s)");
  });

  it("criar_eventos_recorrentes: lista longa vem compacta para o modelo", async () => {
    const client = await conectar(apiDeLote());
    const r = await chamar(client, "criar_eventos_recorrentes", { ...jiuJitsu, ate: "2027-06-30" });
    expect(r.structuredContent?.total).toBeGreaterThan(30);
    expect(texto(r)).toMatch(/… \(\+\d+ eventos; use listar_eventos/);
  });

  it("criar_eventos_recorrentes: horaFim antes de horaInicio → isError sem chamar a API", async () => {
    const f = apiDeLote();
    const client = await conectar(f);
    const r = await chamar(client, "criar_eventos_recorrentes", { ...jiuJitsu, horaFim: "19:00" });
    expect(r.isError).toBe(true);
    expect(texto(r)).toBe("horaFim deve ser depois de horaInicio (no mesmo dia).");
    expect(f).not.toHaveBeenCalled();
  });

  it("criar_eventos_recorrentes: acima de 500 ocorrências → isError orientando a dividir", async () => {
    const f = apiDeLote();
    const client = await conectar(f);
    const r = await chamar(client, "criar_eventos_recorrentes", {
      ...jiuJitsu,
      diasDaSemana: ["dom", "seg", "ter", "qua", "qui", "sex", "sab"],
      de: "2026-01-01",
      ate: "2027-12-31",
    });
    expect(r.isError).toBe(true);
    expect(texto(r)).toBe("Isso geraria 730 eventos; o máximo é 500 por chamada. Divida o período em partes.");
    expect(f).not.toHaveBeenCalled();
  });

  it("criar_eventos_em_lote: erro de um item volta com o índice", async () => {
    const msg = "Dados inválidos — eventos.1.fim: fim deve ser depois de inicio";
    const client = await conectar(mockFetch(() => ({ status: 400, body: { erro: msg } })));
    const r = await chamar(client, "criar_eventos_em_lote", {
      eventos: [
        { titulo: "A", inicio: "2026-11-20T10:00:00-03:00", fim: "2026-11-20T11:00:00-03:00" },
        { titulo: "B", inicio: "2026-11-20T12:00:00-03:00", fim: "2026-11-20T11:00:00-03:00" },
      ],
    });
    expect(r.isError).toBe(true);
    expect(texto(r)).toBe(msg);
  });

  it("remover_eventos_em_lote: uma chamada com todos os ids", async () => {
    const f = apiDeLote();
    const client = await conectar(f);
    const ids = [evento().id, outro.id];
    const r = await chamar(client, "remover_eventos_em_lote", { ids });
    expect(r.structuredContent).toEqual({ removidos: 2 });
    expect(f.mock.calls).toHaveLength(1);
    expect(JSON.parse(String(f.mock.calls[0]![1]!.body))).toEqual({ ids });
  });
});
