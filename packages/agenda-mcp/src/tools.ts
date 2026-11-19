import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DATE_FORMAT_EXAMPLE, DateTime, EventSchema, type Event } from "@agenda/api/schemas";
import { z } from "zod";
import { ApiError, type ApiClient } from "./api-client.js";

// ---------------------------------------------------------------------------
// Snippets reused across descriptions (descriptions are the tool's "prompt")
// ---------------------------------------------------------------------------

const FORMAT = `Dates ALWAYS in ISO 8601 with a timezone, e.g. ${DATE_FORMAT_EXAMPLE}. Never omit the offset; if the user does not state a timezone, use theirs (São Paulo = -03:00).`;
const RELATIVE = `Convert relative dates ("tomorrow", "Friday", "next week") to absolute dates based on the conversation's current date before calling.`;
const ID = `Every response includes each event's id (UUID): keep it to get, update or delete the event later.`;

const dateDesc = (o: string) => `${o}. ${FORMAT}`;

// ---------------------------------------------------------------------------
// Input/output schemas
// ---------------------------------------------------------------------------

const EventId = z
  .uuid({ error: "id must be a UUID; use list_events to find the event id" })
  .describe("Event id (UUID), from list_events, get_event or create_event");

const Range = {
  from: DateTime.describe(dateDesc("Range start (inclusive)")),
  to: DateTime.describe(dateDesc("Range end (exclusive); must be after `from`")),
};

const EventSummary = EventSchema.pick({ id: true, title: true, start: true, end: true });

const EventOutput = { event: EventSchema };
const EventWithConflictsOutput = {
  event: EventSchema,
  conflicts: z.array(EventSummary).describe("Other events overlapping this one. Empty = no conflict."),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Data = Record<string, unknown>;

function ok(summary: string, data: Data): CallToolResult {
  return {
    content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }],
    structuredContent: data,
  };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Turns any error into an isError result with a message useful to the model (no stack trace). */
async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 404 && e.message.startsWith("Event not found")) {
        return fail(`${e.message}. Use list_events to find the correct id.`);
      }
      return fail(e.message);
    }
    console.error("[agenda-mcp] unexpected error:", e);
    return fail("Unexpected error in the agenda MCP server. Try again; if it persists, tell the user.");
  }
}

const summarize = ({ id, title, start, end }: Event) => ({ id, title, start, end });

const line = (e: Pick<Event, "id" | "title" | "start" | "end">) => `- ${e.title} | ${e.start} → ${e.end} | id ${e.id}`;

async function conflictsOf(api: ApiClient, ev: Event) {
  const overlapping = await api.list(ev.start, ev.end);
  return overlapping.filter((o) => o.id !== ev.id).map(summarize);
}

function conflictWarning(conflicts: ReturnType<typeof summarize>[]): string {
  if (!conflicts.length) return "No schedule conflicts.";
  return `WARNING: conflicts with ${conflicts.length} event(s):\n${conflicts.map(line).join("\n")}\nTell the user.`;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function registerTools(server: McpServer, api: ApiClient): void {
  server.registerTool(
    "list_events",
    {
      title: "List events",
      description: [
        "Lists agenda events that overlap a time range (including events that start before it and end inside it).",
        `Use for questions like "what do I have tomorrow?", "how does my week look?" and to find an event's id before updating or deleting it. For a whole day, use from = 00:00 of that day and to = 00:00 of the next day.`,
        RELATIVE,
        FORMAT,
        ID,
      ].join("\n"),
      inputSchema: Range,
      outputSchema: {
        from: z.string(),
        to: z.string(),
        total: z.number().int(),
        events: z.array(EventSchema).describe("Ordered by start"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ from, to }) =>
      run(async () => {
        const events = await api.list(from, to);
        const summary = events.length
          ? `${events.length} event(s) between ${from} and ${to}:\n${events.map(line).join("\n")}`
          : `No events between ${from} and ${to}.`;
        return ok(summary, { from, to, total: events.length, events });
      }),
  );

  server.registerTool(
    "get_event",
    {
      title: "Get event",
      description: [
        "Returns all data of an event by id, including its description.",
        "Use when you already have the id (from a previous response) and need the details. If you do not have the id, use list_events first.",
      ].join("\n"),
      inputSchema: { id: EventId },
      outputSchema: EventOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ id }) =>
      run(async () => {
        const event = await api.get(id);
        return ok(`Event found:\n${line(event)}`, { event });
      }),
  );

  server.registerTool(
    "create_event",
    {
      title: "Create event",
      description: [
        `Creates an agenda event. Use for requests like "book a meeting Friday 2pm to 3pm".`,
        "If the user does not give an end time, ask or assume 1 hour and say so.",
        "This tool does NOT block overlaps: the event is created even when there is a conflict, and the conflicting events come back in `conflicts`. If you are not sure the slot is free, call check_availability first and confirm with the user.",
        RELATIVE,
        FORMAT,
        ID,
      ].join("\n"),
      inputSchema: {
        title: z.string().min(1).max(200).describe('Short event title, e.g. "Meeting with the sales team"'),
        start: DateTime.describe(dateDesc("Event start")),
        end: DateTime.describe(dateDesc("Event end; must be after `start`")),
        description: z.string().max(2000).optional().describe("Optional details: agenda, location, link"),
      },
      outputSchema: EventWithConflictsOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args) =>
      run(async () => {
        const event = await api.create(args);
        const conflicts = await conflictsOf(api, event);
        return ok(`Event created:\n${line(event)}\n${conflictWarning(conflicts)}`, { event, conflicts });
      }),
  );

  server.registerTool(
    "update_event",
    {
      title: "Update event",
      description: [
        "Changes fields of an existing event. Send only the fields that change; the rest are kept.",
        "Use to reschedule, rename or change the description. To reschedule keeping the duration, send `start` and `end` together. `description: null` clears the description.",
        "Needs the id: if you do not have it, use list_events first. Does not block overlaps; conflicts come back in `conflicts`.",
        RELATIVE,
        FORMAT,
      ].join("\n"),
      inputSchema: {
        id: EventId,
        title: z.string().min(1).max(200).optional().describe("New title"),
        start: DateTime.optional().describe(dateDesc("New start")),
        end: DateTime.optional().describe(dateDesc("New end")),
        description: z.string().max(2000).nullable().optional().describe("New description; null clears it"),
      },
      outputSchema: EventWithConflictsOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ id, ...fields }) =>
      run(async () => {
        if (Object.values(fields).every((v) => v === undefined)) {
          return fail("Provide at least one field to update: title, start, end or description.");
        }
        const event = await api.update(id, fields);
        const conflicts = await conflictsOf(api, event);
        return ok(`Event updated:\n${line(event)}\n${conflictWarning(conflicts)}`, { event, conflicts });
      }),
  );

  server.registerTool(
    "delete_event",
    {
      title: "Delete event",
      description: [
        `Deletes (cancels) an event permanently. It cannot be undone. Use for requests like "cancel Thursday's event".`,
        "Needs the id: use list_events to find it. If more than one event could match the request, ask the user which one before deleting.",
      ].join("\n"),
      inputSchema: { id: EventId },
      outputSchema: { deleted: z.literal(true), event: EventSchema.describe("Data of the deleted event") },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ id }) =>
      run(async () => {
        const event = await api.get(id);
        await api.delete(id);
        return ok(`Event deleted:\n${line(event)}`, { deleted: true, event });
      }),
  );

  server.registerTool(
    "check_availability",
    {
      title: "Check availability",
      description: [
        "Checks whether a time range is free in the agenda and lists the conflicting events, if any.",
        `Use before creating or rescheduling an event and for questions like "am I free Friday at 2pm?".`,
        "Events that only touch at the edge (one ends at 3pm, another starts at 3pm) do NOT conflict.",
        RELATIVE,
        FORMAT,
      ].join("\n"),
      inputSchema: Range,
      outputSchema: {
        free: z.boolean(),
        from: z.string(),
        to: z.string(),
        conflicts: z.array(EventSummary),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ from, to }) =>
      run(async () => {
        const conflicts = (await api.list(from, to)).map(summarize);
        const free = conflicts.length === 0;
        const summary = free
          ? `Free: no events between ${from} and ${to}.`
          : `Busy: ${conflicts.length} conflict(s) between ${from} and ${to}:\n${conflicts.map(line).join("\n")}`;
        return ok(summary, { free, from, to, conflicts });
      }),
  );
}
