import Fastify, { type FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Agente, Conversa } from "./agente.js";
import type { ContextoUsuario, EventoChat } from "./eventos.js";

const Contexto = {
  agora: z.string().min(10),
  fuso: z.string().min(1).default("America/Sao_Paulo"),
};
const MensagemSchema = z.object({
  conversaId: z.string().optional(),
  texto: z.string().trim().min(1).max(4000),
  ...Contexto,
});
const ConfirmacaoSchema = z.object({
  conversaId: z.string(),
  callId: z.string(),
  aprovado: z.boolean(),
  ...Contexto,
});

/** Mensagem segura para o usuário: nunca stack trace. */
function mensagemDeErro(e: unknown): string {
  const err = e as { status?: number; message?: string; name?: string };
  if (err?.status === 401) return "A chave da OpenAI foi recusada (401). Verifique OPENAI_API_KEY / OPENAI_ENV_FILE.";
  if (err?.status === 429) return "Limite da OpenAI atingido (429). Espere um pouco e tente de novo.";
  if (err?.status) return `A OpenAI respondeu ${err.status}: ${err.message ?? "erro desconhecido"}`;
  return `Erro no servidor de chat: ${err?.message ?? String(e)}`;
}

export function buildChatApp({ agente, modelo }: { agente: Agente; modelo?: string }) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  const conversas = new Map<string, Conversa>();
  const ocupadas = new Set<string>();

  /** Abre um stream SSE, roda `fn` emitindo eventos e fecha com `fim`. */
  async function stream(reply: FastifyReply, conv: Conversa, fn: (emitir: (e: EventoChat) => void) => Promise<void>) {
    if (ocupadas.has(conv.id)) {
      return reply.code(409).send({ erro: "Esta conversa ainda está processando a mensagem anterior." });
    }
    ocupadas.add(conv.id);
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const emitir = (e: EventoChat) => {
      if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    emitir({ tipo: "inicio", conversaId: conv.id });
    try {
      await fn(emitir);
    } catch (e) {
      app.log.error(e);
      emitir({ tipo: "erro", mensagem: mensagemDeErro(e) });
    } finally {
      ocupadas.delete(conv.id);
      emitir({ tipo: "fim" });
      reply.raw.end();
    }
  }

  function invalido(reply: FastifyReply, error: z.ZodError) {
    return reply.code(400).send({ erro: z.prettifyError(error) });
  }

  app.get("/chat/health", () => ({ ok: true, modelo }));

  app.post("/chat", async (req, reply) => {
    const r = MensagemSchema.safeParse(req.body);
    if (!r.success) return invalido(reply, r.error);
    const { conversaId, texto, ...ctx } = r.data;
    let conv = conversaId ? conversas.get(conversaId) : undefined;
    if (!conv) {
      conv = { id: randomUUID(), itens: [] };
      conversas.set(conv.id, conv);
    }
    const c = conv;
    return stream(reply, c, (emitir) => agente.enviarMensagem(c, texto, ctx as ContextoUsuario, emitir));
  });

  app.post("/chat/confirmar", async (req, reply) => {
    const r = ConfirmacaoSchema.safeParse(req.body);
    if (!r.success) return invalido(reply, r.error);
    const { conversaId, callId, aprovado, ...ctx } = r.data;
    const conv = conversas.get(conversaId);
    if (!conv) return reply.code(404).send({ erro: "Conversa não encontrada (o servidor de chat foi reiniciado?)." });
    return stream(reply, conv, (emitir) => agente.confirmar(conv, callId, aprovado, ctx as ContextoUsuario, emitir));
  });

  return app;
}
