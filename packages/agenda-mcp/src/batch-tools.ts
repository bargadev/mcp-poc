import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DateTime, EventSchema, MAX_BATCH, type CreateEvent, type Event } from "@agenda/api/schemas";
import { z } from "zod";
import { ApiError, type ApiClient } from "./api-client.js";
import { expandRecurrence, WEEKDAYS } from "./recurrence.js";

const EventSummary = EventSchema.pick({ id: true, title: true, start: true, end: true });
type Summary = z.infer<typeof EventSummary>;

const BatchOutput = {
  total: z.number().int(),
  events: z.array(EventSummary).describe("Created events, ordered by start"),
  conflicts: z
    .array(z.object({ occurrence: EventSummary, existing: EventSummary }))
    .describe("Pairs (created event, pre-existing event) with overlapping times"),
};

const summarize = ({ id, title, start, end }: Event): Summary => ({ id, title, start, end });
const line = (e: Summary) => `- ${e.title} | ${e.start} → ${e.end} | id ${e.id}`;

function ok(summary: string, data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(data)}` }], structuredContent: data };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError) return fail(e.message);
    console.error("[agenda-mcp] unexpected error:", e);
    return fail("Unexpected error in the agenda MCP server. Try again; if it persists, tell the user.");
  }
}

/** A long list becomes head + tail, so it does not flood the model's context. */
function compactList(events: Summary[], max = 30): string {
  if (events.length <= max) return events.map(line).join("\n");
  return [
    ...events.slice(0, 5).map(line),
    `- … (+${events.length - 6} events; use list_events on the period to see all ids)`,
    line(events.at(-1)!),
  ].join("\n");
}

/** Creates in batch (atomic in the API) and cross-checks against what already existed in the period. */
async function createAndCheck(api: ApiClient, toCreate: CreateEvent[]) {
  const { events } = await api.createMany(toCreate);
  const created = events.map(summarize).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const newIds = new Set(created.map((e) => e.id));
  const min = created.reduce((m, e) => Math.min(m, Date.parse(e.start)), Infinity);
  const max = created.reduce((m, e) => Math.max(m, Date.parse(e.end)), -Infinity);
  const existing = (await api.list(new Date(min).toISOString(), new Date(max).toISOString()))
    .filter((e) => !newIds.has(e.id))
    .map(summarize);
  const conflicts = created.flatMap((occurrence) =>
    existing
      .filter((x) => Date.parse(x.start) < Date.parse(occurrence.end) && Date.parse(x.end) > Date.parse(occurrence.start))
      .map((ex) => ({ occurrence, existing: ex })),
  );
  return { created, conflicts };
}

function conflictText(conflicts: { occurrence: Summary; existing: Summary }[]): string {
  if (!conflicts.length) return "No schedule conflicts.";
  const lines = conflicts
    .slice(0, 10)
    .map((c) => `- ${c.occurrence.start}: conflicts with "${c.existing.title}" (${c.existing.start} → ${c.existing.end})`);
  const rest = conflicts.length > 10 ? `\n- … (+${conflicts.length - 10})` : "";
  return `WARNING: ${conflicts.length} conflict(s):\n${lines.join("\n")}${rest}\nTell the user.`;
}

const TimeHHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use 24h HH:MM, e.g. 19:30");

export function registerBatchTools(server: McpServer, api: ApiClient): void {
  server.registerTool(
    "create_recurring_events",
    {
      title: "Create recurring events",
      description: [
        `Creates a weekly series of events in one go: "jiu-jitsu every Mon, Wed and Fri 7:30pm to 8:30pm until the end of the year", "daily standup Mon to Fri at 9am".`,
        "ALWAYS use this tool for repetitions instead of calling create_event many times. One call creates every occurrence (atomic: all or none).",
        "The agenda does not store recurrence rules: each occurrence becomes an independent event with its own id.",
        `At most ${MAX_BATCH} occurrences per call. If the user does not say until when, ask (or suggest the end of the year).`,
        "Convert relative dates to absolute ones based on the conversation's current date.",
      ].join("\n"),
      inputSchema: {
        title: z.string().min(1).max(200).describe("Title of each occurrence"),
        description: z.string().max(2000).optional().describe("Optional description, repeated in all of them"),
        weekdays: z
          .array(z.enum(WEEKDAYS))
          .min(1)
          .describe('Weekdays: "sun", "mon", "tue", "wed", "thu", "fri", "sat"'),
        startTime: TimeHHMM.describe('Start time, 24h "HH:MM", e.g. "19:30"'),
        endTime: TimeHHMM.describe('End time on the same day, 24h "HH:MM", e.g. "20:30"'),
        from: z.iso.date().describe('First day of the period (inclusive), "YYYY-MM-DD"'),
        to: z.iso.date().describe('Last day of the period (inclusive), "YYYY-MM-DD"'),
        offset: z
          .string()
          .regex(/^[+-]\d\d:\d\d$/, 'use the format "-03:00"')
          .default("-03:00")
          .describe('User timezone offset, e.g. "-03:00" (São Paulo)'),
      },
      outputSchema: BatchOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      run(async () => {
        if (args.endTime <= args.startTime) return fail("endTime must be after startTime (same day).");
        if (args.to < args.from) return fail("to must be on or after from.");
        const toCreate = expandRecurrence(args);
        if (!toCreate.length) return fail("No day in the period falls on the requested weekdays. Nothing was created.");
        if (toCreate.length > MAX_BATCH) {
          return fail(`That would create ${toCreate.length} events; the maximum is ${MAX_BATCH} per call. Split the period.`);
        }
        const { created, conflicts } = await createAndCheck(api, toCreate);
        const rule = `${args.weekdays.join("/")} ${args.startTime}–${args.endTime}, from ${args.from} to ${args.to}`;
        return ok(
          `Created ${created.length} "${args.title}" events (${rule}):\n${compactList(created)}\n${conflictText(conflicts)}`,
          { total: created.length, events: created, conflicts },
        );
      }),
  );

  server.registerTool(
    "create_events_batch",
    {
      title: "Create events in batch",
      description: [
        "Creates several different events in a single call (atomic: all or none).",
        "Use whenever you create 2 or more events that do NOT follow a weekly pattern (for a weekly pattern, use create_recurring_events).",
        "Dates in ISO 8601 with a timezone, e.g. 2026-11-20T15:00:00-03:00.",
      ].join("\n"),
      inputSchema: {
        events: z
          .array(
            z.object({
              title: z.string().min(1).max(200),
              start: DateTime,
              end: DateTime,
              description: z.string().max(2000).optional(),
            }),
          )
          .min(1)
          .max(MAX_BATCH)
          .describe("Events to create"),
      },
      outputSchema: BatchOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ events }) =>
      run(async () => {
        const { created, conflicts } = await createAndCheck(api, events);
        return ok(`Created ${created.length} events:\n${compactList(created)}\n${conflictText(conflicts)}`, {
          total: created.length,
          events: created,
          conflicts,
        });
      }),
  );

  server.registerTool(
    "delete_events_batch",
    {
      title: "Delete events in batch",
      description: [
        `Deletes several events at once, permanently. Use for "cancel all jiu-jitsu sessions", "clear my Friday".`,
        "ALWAYS use this tool to delete 2 or more events instead of calling delete_event many times: the user confirms only once.",
        "Get the ids with list_events on the period and filter by what the user asked. Atomic: if any id does not exist, nothing is deleted.",
      ].join("\n"),
      inputSchema: {
        ids: z.array(z.uuid()).min(1).max(MAX_BATCH).describe("ids (UUID) of the events to delete, from list_events"),
      },
      outputSchema: { deleted: z.number().int() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ ids }) =>
      run(async () => {
        const { deleted } = await api.deleteMany(ids);
        return ok(`${deleted} event(s) deleted.`, { deleted });
      }),
  );
}
