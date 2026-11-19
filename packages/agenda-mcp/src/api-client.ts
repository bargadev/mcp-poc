import type { AtualizarEvento, CriarEvento, ErroApi, Evento } from "@agenda/api/schemas";

/** Erro com mensagem já pronta para ser mostrada ao modelo. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly detalhes?: ErroApi["detalhes"],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface OpcoesApiClient {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function criarApiClient({ baseUrl, fetch: f = fetch, timeoutMs = 10_000 }: OpcoesApiClient) {
  const base = baseUrl.replace(/\/+$/, "");

  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await f(`${base}${path}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new ApiError(
        `Não foi possível conectar à API de agenda em ${base}. Verifique se ela está rodando (pnpm dev:api) e se AGENDA_API_URL está correta.`,
      );
    }

    if (res.status === 204) return undefined as T;

    const texto = await res.text();
    let json: unknown;
    try {
      json = texto ? JSON.parse(texto) : undefined;
    } catch {
      json = undefined;
    }

    if (!res.ok) {
      const erro = (json as Partial<ErroApi> | undefined)?.erro;
      throw new ApiError(
        erro ??
          `A API em ${base} respondeu ${res.status} para ${method} ${path} sem mensagem de erro. Verifique se AGENDA_API_URL aponta para a API de agenda.`,
        res.status,
        (json as Partial<ErroApi> | undefined)?.detalhes,
      );
    }
    return json as T;
  }

  return {
    listar(de: string, ate: string): Promise<Evento[]> {
      const q = new URLSearchParams({ de, ate });
      return req("GET", `/eventos?${q}`);
    },
    buscar(id: string): Promise<Evento> {
      return req("GET", `/eventos/${encodeURIComponent(id)}`);
    },
    criar(dados: CriarEvento): Promise<Evento> {
      return req("POST", "/eventos", dados);
    },
    atualizar(id: string, dados: AtualizarEvento): Promise<Evento> {
      return req("PATCH", `/eventos/${encodeURIComponent(id)}`, dados);
    },
    remover(id: string): Promise<void> {
      return req("DELETE", `/eventos/${encodeURIComponent(id)}`);
    },
    criarVarios(eventos: CriarEvento[]): Promise<{ eventos: Evento[] }> {
      return req("POST", "/eventos/lote", { eventos });
    },
    removerVarios(ids: string[]): Promise<{ removidos: number }> {
      return req("POST", "/eventos/lote/remover", { ids });
    },
  };
}

export type ApiClient = ReturnType<typeof criarApiClient>;
