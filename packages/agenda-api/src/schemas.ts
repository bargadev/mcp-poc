import { z } from "zod";

export const DATE_FORMAT_EXAMPLE = "2026-11-20T15:00:00-03:00";

const MSG_REQUIRED = "required field";

/** ISO 8601 with a mandatory timezone (Z or ±hh:mm). */
export const DateTime = z.iso.datetime({
  offset: true,
  error: (iss) =>
    iss.input === undefined ? MSG_REQUIRED : `must be ISO 8601 with a timezone, e.g. ${DATE_FORMAT_EXAMPLE}`,
});

const Title = z
  .string({ error: (iss) => (iss.input === undefined ? MSG_REQUIRED : "must be a string") })
  .trim()
  .min(1, "must not be empty")
  .max(200, "must be at most 200 characters");

const Description = z
  .string({ error: "must be a string" })
  .trim()
  .max(2000, "must be at most 2000 characters");

export const endsAfterStart = (start: string, end: string): boolean => Date.parse(end) > Date.parse(start);

export const MSG_END_BEFORE_START = "end must be after start";

export const CreateEventSchema = z
  .strictObject({
    title: Title,
    description: Description.optional(),
    start: DateTime,
    end: DateTime,
  })
  .refine((v) => endsAfterStart(v.start, v.end), {
    message: MSG_END_BEFORE_START,
    path: ["end"],
  });

/**
 * Partial update. `description: null` clears the field.
 * The end > start rule is checked after merging with the current event (see app.ts).
 */
export const UpdateEventSchema = z
  .strictObject({
    title: Title.optional(),
    description: Description.nullable().optional(),
    start: DateTime.optional(),
    end: DateTime.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "provide at least one field to update (title, description, start, end)",
  });

export const RangeQuerySchema = z
  .object({
    from: DateTime.optional(),
    to: DateTime.optional(),
  })
  .refine((v) => !v.from || !v.to || endsAfterStart(v.from, v.to), {
    message: "to must be after from",
    path: ["to"],
  });

export const IdParamSchema = z.object({
  id: z.uuid({ error: "must be a UUID" }),
});

export const EventSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  /** Kept with the offset sent on create/update. */
  start: DateTime,
  end: DateTime,
  /** UTC. */
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const ApiErrorSchema = z.object({
  error: z.string(),
  details: z.array(z.object({ field: z.string(), message: z.string() })).optional(),
});

export const MAX_BATCH = 500;

/** Batch create: atomic (creates all or none). */
export const CreateEventsBatchSchema = z.strictObject({
  events: z
    .array(CreateEventSchema)
    .min(1, "provide at least 1 event")
    .max(MAX_BATCH, `at most ${MAX_BATCH} events per batch`),
});

/** Batch delete: atomic (if any id does not exist, nothing is deleted). */
export const DeleteEventsBatchSchema = z.strictObject({
  ids: z
    .array(z.uuid({ error: "must be a UUID" }))
    .min(1, "provide at least 1 id")
    .max(MAX_BATCH, `at most ${MAX_BATCH} ids per batch`),
});

export type Event = z.infer<typeof EventSchema>;
export type CreateEvent = z.infer<typeof CreateEventSchema>;
export type UpdateEvent = z.infer<typeof UpdateEventSchema>;
export type RangeQuery = z.infer<typeof RangeQuerySchema>;
export type ApiErrorBody = z.infer<typeof ApiErrorSchema>;
export type CreateEventsBatch = z.infer<typeof CreateEventsBatchSchema>;
export type DeleteEventsBatch = z.infer<typeof DeleteEventsBatchSchema>;
