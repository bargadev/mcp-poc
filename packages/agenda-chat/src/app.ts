import Fastify, { type FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Agent, Conversation } from "./agent.js";
import type { ChatEvent, UserContext } from "./events.js";

const Context = {
  now: z.string().min(10),
  timeZone: z.string().min(1).default("America/Sao_Paulo"),
};
const MessageSchema = z.object({
  conversationId: z.string().optional(),
  text: z.string().trim().min(1).max(4000),
  ...Context,
});
const ConfirmationSchema = z.object({
  conversationId: z.string(),
  callId: z.string(),
  approved: z.boolean(),
  ...Context,
});

/** User-safe message: never a stack trace. */
function errorMessage(e: unknown): string {
  const err = e as { status?: number; message?: string; name?: string };
  if (err?.status === 401) return "The OpenAI key was rejected (401). Check OPENAI_API_KEY / OPENAI_ENV_FILE.";
  if (err?.status === 429) return "OpenAI rate limit reached (429). Wait a bit and try again.";
  if (err?.status) return `OpenAI responded ${err.status}: ${err.message ?? "unknown error"}`;
  return `Chat server error: ${err?.message ?? String(e)}`;
}

export function buildChatApp({ agent, model }: { agent: Agent; model?: string }) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  const conversations = new Map<string, Conversation>();
  const busy = new Set<string>();

  /** Opens an SSE stream, runs `fn` emitting events and closes with `done`. */
  async function stream(reply: FastifyReply, conv: Conversation, fn: (emit: (e: ChatEvent) => void) => Promise<void>) {
    if (busy.has(conv.id)) {
      return reply.code(409).send({ error: "This conversation is still processing the previous message." });
    }
    busy.add(conv.id);
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const emit = (e: ChatEvent) => {
      if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    emit({ type: "start", conversationId: conv.id });
    try {
      await fn(emit);
    } catch (e) {
      app.log.error(e);
      emit({ type: "error", message: errorMessage(e) });
    } finally {
      busy.delete(conv.id);
      emit({ type: "done" });
      reply.raw.end();
    }
  }

  function invalid(reply: FastifyReply, error: z.ZodError) {
    return reply.code(400).send({ error: z.prettifyError(error) });
  }

  app.get("/chat/health", () => ({ ok: true, model }));

  app.post("/chat", async (req, reply) => {
    const r = MessageSchema.safeParse(req.body);
    if (!r.success) return invalid(reply, r.error);
    const { conversationId, text, ...ctx } = r.data;
    let conv = conversationId ? conversations.get(conversationId) : undefined;
    if (!conv) {
      conv = { id: randomUUID(), items: [] };
      conversations.set(conv.id, conv);
    }
    const c = conv;
    return stream(reply, c, (emit) => agent.sendMessage(c, text, ctx as UserContext, emit));
  });

  app.post("/chat/confirm", async (req, reply) => {
    const r = ConfirmationSchema.safeParse(req.body);
    if (!r.success) return invalid(reply, r.error);
    const { conversationId, callId, approved, ...ctx } = r.data;
    const conv = conversations.get(conversationId);
    if (!conv) return reply.code(404).send({ error: "Conversation not found (was the chat server restarted?)." });
    return stream(reply, conv, (emit) => agent.confirm(conv, callId, approved, ctx as UserContext, emit));
  });

  return app;
}
