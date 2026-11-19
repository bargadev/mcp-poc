import Fastify, { type FastifyReply, type FastifyServerOptions } from "fastify";
import type { z } from "zod";
import type { Db } from "./db.js";
import { createRepository } from "./repository.js";
import {
  type ApiErrorBody,
  CreateEventSchema,
  CreateEventsBatchSchema,
  DeleteEventsBatchSchema,
  endsAfterStart,
  IdParamSchema,
  MSG_END_BEFORE_START,
  RangeQuerySchema,
  UpdateEventSchema,
} from "./schemas.js";

type Detail = NonNullable<ApiErrorBody["details"]>[number];

function zodDetails(error: z.ZodError): Detail[] {
  return error.issues.map((iss) => {
    const field = iss.path.length ? iss.path.join(".") : "(body)";
    if (iss.code === "unrecognized_keys") {
      return { field, message: `unknown field(s): ${iss.keys.join(", ")}` };
    }
    return { field, message: iss.message };
  });
}

function replyInvalid(reply: FastifyReply, details: Detail[]) {
  const summary = details.map((d) => `${d.field}: ${d.message}`).join("; ");
  const body: ApiErrorBody = { error: `Invalid data — ${summary}`, details };
  return reply.code(400).send(body);
}

function notFound(reply: FastifyReply, id: string) {
  const body: ApiErrorBody = { error: `Event not found with id ${id}` };
  return reply.code(404).send(body);
}

/** Validates with Zod; on failure it already replies 400 and returns undefined. */
function validate<S extends z.ZodType>(schema: S, data: unknown, reply: FastifyReply): z.infer<S> | undefined {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  void replyInvalid(reply, zodDetails(r.error));
  return undefined;
}

export interface AppOptions {
  db: Db;
  logger?: FastifyServerOptions["logger"];
}

export function buildApp({ db, logger = false }: AppOptions) {
  const app = Fastify({ logger });
  const repo = createRepository(db);

  app.setErrorHandler((err: { statusCode?: number; message: string }, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      req.log.error(err);
      const body: ApiErrorBody = { error: "Internal error in the agenda API" };
      return reply.code(500).send(body);
    }
    // Fastify's own errors (malformed JSON, content-type, empty body, etc.)
    const body: ApiErrorBody = { error: `Invalid request — ${err.message}` };
    return reply.code(status).send(body);
  });

  app.setNotFoundHandler((req, reply) => {
    const body: ApiErrorBody = { error: `Route not found: ${req.method} ${req.url}` };
    return reply.code(404).send(body);
  });

  app.get("/events", (req, reply) => {
    const q = validate(RangeQuerySchema, req.query, reply);
    if (!q) return reply;
    return repo.list(q);
  });

  app.get("/events/:id", (req, reply) => {
    const p = validate(IdParamSchema, req.params, reply);
    if (!p) return reply;
    return repo.get(p.id) ?? notFound(reply, p.id);
  });

  app.post("/events", (req, reply) => {
    const data = validate(CreateEventSchema, req.body, reply);
    if (!data) return reply;
    return reply.code(201).send(repo.create(data));
  });

  app.patch("/events/:id", (req, reply) => {
    const p = validate(IdParamSchema, req.params, reply);
    if (!p) return reply;
    const patch = validate(UpdateEventSchema, req.body, reply);
    if (!patch) return reply;

    const current = repo.get(p.id);
    if (!current) return notFound(reply, p.id);

    const next = {
      title: patch.title ?? current.title,
      description: patch.description === undefined ? current.description : patch.description,
      start: patch.start ?? current.start,
      end: patch.end ?? current.end,
    };
    if (!endsAfterStart(next.start, next.end)) {
      return replyInvalid(reply, [
        { field: "end", message: `${MSG_END_BEFORE_START} (result: start=${next.start}, end=${next.end})` },
      ]);
    }
    return repo.update(p.id, next);
  });

  app.post("/events/batch", (req, reply) => {
    const data = validate(CreateEventsBatchSchema, req.body, reply);
    if (!data) return reply;
    return reply.code(201).send({ events: repo.createMany(data.events) });
  });

  app.post("/events/batch/delete", (req, reply) => {
    const data = validate(DeleteEventsBatchSchema, req.body, reply);
    if (!data) return reply;
    const missing = repo.missing(data.ids);
    if (missing.length) {
      const body: ApiErrorBody = {
        error: `No events were deleted: ${missing.length} id(s) not found: ${missing.join(", ")}`,
      };
      return reply.code(404).send(body);
    }
    return { deleted: repo.deleteMany(data.ids) };
  });

  app.delete("/events/:id", (req, reply) => {
    const p = validate(IdParamSchema, req.params, reply);
    if (!p) return reply;
    return repo.delete(p.id) ? reply.code(204).send() : notFound(reply, p.id);
  });

  return app;
}
