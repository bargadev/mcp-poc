import Fastify, { type FastifyReply, type FastifyServerOptions } from "fastify";
import type { z } from "zod";
import type { Db } from "./db.js";
import { criarRepositorio } from "./repositorio.js";
import {
  AtualizarEventoSchema,
  CriarEventoSchema,
  CriarEventosLoteSchema,
  RemoverEventosLoteSchema,
  type ErroApi,
  fimDepoisDeInicio,
  IdParamSchema,
  IntervaloQuerySchema,
  MSG_FIM_ANTES_INICIO,
} from "./schemas.js";

type Detalhe = NonNullable<ErroApi["detalhes"]>[number];

function detalhesDoZod(error: z.ZodError): Detalhe[] {
  return error.issues.map((iss) => {
    const campo = iss.path.length ? iss.path.join(".") : "(corpo)";
    if (iss.code === "unrecognized_keys") {
      return { campo, mensagem: `campo(s) desconhecido(s): ${iss.keys.join(", ")}` };
    }
    return { campo, mensagem: iss.message };
  });
}

function responderInvalido(reply: FastifyReply, detalhes: Detalhe[]) {
  const resumo = detalhes.map((d) => `${d.campo}: ${d.mensagem}`).join("; ");
  const corpo: ErroApi = { erro: `Dados inválidos — ${resumo}`, detalhes };
  return reply.code(400).send(corpo);
}

function naoEncontrado(reply: FastifyReply, id: string) {
  const corpo: ErroApi = { erro: `Evento não encontrado com id ${id}` };
  return reply.code(404).send(corpo);
}

/** Valida com Zod; em caso de erro já responde 400 e retorna undefined. */
function validar<S extends z.ZodType>(schema: S, dados: unknown, reply: FastifyReply): z.infer<S> | undefined {
  const r = schema.safeParse(dados);
  if (r.success) return r.data;
  void responderInvalido(reply, detalhesDoZod(r.error));
  return undefined;
}

export interface OpcoesApp {
  db: Db;
  logger?: FastifyServerOptions["logger"];
}

export function buildApp({ db, logger = false }: OpcoesApp) {
  const app = Fastify({ logger });
  const repo = criarRepositorio(db);

  app.setErrorHandler((err: { statusCode?: number; message: string }, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      req.log.error(err);
      const corpo: ErroApi = { erro: "Erro interno na API de agenda" };
      return reply.code(500).send(corpo);
    }
    // Erros do próprio Fastify (JSON malformado, content-type, body vazio etc.)
    const corpo: ErroApi = { erro: `Requisição inválida — ${err.message}` };
    return reply.code(status).send(corpo);
  });

  app.setNotFoundHandler((req, reply) => {
    const corpo: ErroApi = { erro: `Rota não encontrada: ${req.method} ${req.url}` };
    return reply.code(404).send(corpo);
  });

  app.get("/eventos", (req, reply) => {
    const q = validar(IntervaloQuerySchema, req.query, reply);
    if (!q) return reply;
    return repo.listar(q);
  });

  app.get("/eventos/:id", (req, reply) => {
    const p = validar(IdParamSchema, req.params, reply);
    if (!p) return reply;
    return repo.buscar(p.id) ?? naoEncontrado(reply, p.id);
  });

  app.post("/eventos", (req, reply) => {
    const dados = validar(CriarEventoSchema, req.body, reply);
    if (!dados) return reply;
    return reply.code(201).send(repo.criar(dados));
  });

  app.patch("/eventos/:id", (req, reply) => {
    const p = validar(IdParamSchema, req.params, reply);
    if (!p) return reply;
    const patch = validar(AtualizarEventoSchema, req.body, reply);
    if (!patch) return reply;

    const atual = repo.buscar(p.id);
    if (!atual) return naoEncontrado(reply, p.id);

    const novo = {
      titulo: patch.titulo ?? atual.titulo,
      descricao: patch.descricao === undefined ? atual.descricao : patch.descricao,
      inicio: patch.inicio ?? atual.inicio,
      fim: patch.fim ?? atual.fim,
    };
    if (!fimDepoisDeInicio(novo.inicio, novo.fim)) {
      return responderInvalido(reply, [
        {
          campo: "fim",
          mensagem: `${MSG_FIM_ANTES_INICIO} (resultado: inicio=${novo.inicio}, fim=${novo.fim})`,
        },
      ]);
    }
    return repo.atualizar(p.id, novo);
  });

  app.post("/eventos/lote", (req, reply) => {
    const dados = validar(CriarEventosLoteSchema, req.body, reply);
    if (!dados) return reply;
    return reply.code(201).send({ eventos: repo.criarVarios(dados.eventos) });
  });

  app.post("/eventos/lote/remover", (req, reply) => {
    const dados = validar(RemoverEventosLoteSchema, req.body, reply);
    if (!dados) return reply;
    const faltando = repo.inexistentes(dados.ids);
    if (faltando.length) {
      const corpo: ErroApi = {
        erro: `Nenhum evento foi removido: ${faltando.length} id(s) não encontrado(s): ${faltando.join(", ")}`,
      };
      return reply.code(404).send(corpo);
    }
    return { removidos: repo.removerVarios(dados.ids) };
  });

  app.delete("/eventos/:id", (req, reply) => {
    const p = validar(IdParamSchema, req.params, reply);
    if (!p) return reply;
    return repo.remover(p.id) ? reply.code(204).send() : naoEncontrado(reply, p.id);
  });

  return app;
}
