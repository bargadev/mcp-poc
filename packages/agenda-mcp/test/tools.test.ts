import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Event } from "@agenda/api/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api-client.js";
import { createServer } from "../src/server.js";

// ---------------------------------------------------------------------------
// Mocked API: fake fetch that delegates to a per-test handler
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

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function connect(fakeFetch: typeof fetch) {
  const server = createServer({
    api: createApiClient({ baseUrl: "http://agenda.test", fetch: fakeFetch }),
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  close = async () => {
    await client.close();
    await server.close();
  };
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

const text = (r: CallToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const event = (over: Partial<Event> = {}): Event => ({
  id: "11111111-1111-4111-8111-111111111111",
  title: "Planning meeting",
  description: null,
  start: "2026-11-20T14:00:00-03:00",
  end: "2026-11-20T15:00:00-03:00",
  createdAt: "2026-11-19T12:00:00.000Z",
  updatedAt: "2026-11-19T12:00:00.000Z",
  ...over,
});

const other = event({
  id: "22222222-2222-4222-8222-222222222222",
  title: "1:1 with manager",
  start: "2026-11-20T14:30:00-03:00",
  end: "2026-11-20T15:30:00-03:00",
});

const MISSING_ID = "00000000-0000-4000-8000-000000000000";

// ---------------------------------------------------------------------------

describe("tool catalog", () => {
  it("exposes the 9 tools with the right annotations and descriptions", async () => {
    const client = await connect(mockFetch(() => ({ status: 500 })));
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    expect(Object.keys(byName).sort()).toEqual([
      "check_availability",
      "create_event",
      "create_events_batch",
      "create_recurring_events",
      "delete_event",
      "delete_events_batch",
      "get_event",
      "list_events",
      "update_event",
    ]);
    expect(byName.delete_events_batch!.annotations?.destructiveHint).toBe(true);
    expect(byName.create_recurring_events!.annotations?.destructiveHint).toBe(false);
    expect(byName.create_events_batch!.annotations?.destructiveHint).toBe(false);

    for (const name of ["list_events", "get_event", "check_availability"]) {
      expect(byName[name]!.annotations?.readOnlyHint, name).toBe(true);
    }
    for (const name of ["create_event", "update_event", "delete_event"]) {
      expect(byName[name]!.annotations?.readOnlyHint, name).toBe(false);
    }
    expect(byName.delete_event!.annotations?.destructiveHint).toBe(true);
    expect(byName.create_event!.annotations?.destructiveHint).toBe(false);

    for (const name of ["list_events", "create_event", "update_event", "check_availability"]) {
      expect(byName[name]!.description, name).toContain("2026-11-20T15:00:00-03:00");
    }
    for (const t of tools) expect(t.outputSchema, t.name).toBeDefined();
  });
});

describe("create_event", () => {
  it("valid creation: sends the body to the API and returns the id", async () => {
    const created = event();
    const f = mockFetch((req) => {
      if (req.method === "POST") return { status: 201, body: created };
      return { status: 200, body: [created] }; // conflict check finds only itself
    });
    const client = await connect(f);

    const r = await call(client, "create_event", {
      title: created.title,
      start: created.start,
      end: created.end,
    });

    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ event: created, conflicts: [] });
    expect(text(r)).toContain(`id ${created.id}`);
    expect(text(r)).toContain("No schedule conflicts");

    const [post, get] = f.mock.calls.map(([url, init]) => ({ url: String(url), init }));
    expect(post!.url).toBe("http://agenda.test/events");
    expect(JSON.parse(String(post!.init?.body))).toEqual({
      title: created.title,
      start: created.start,
      end: created.end,
    });
    expect(get!.url).toBe(
      `http://agenda.test/events?from=${encodeURIComponent(created.start)}&to=${encodeURIComponent(created.end)}`,
    );
  });

  it("schedule conflict: creates and returns the conflicting events with ids", async () => {
    const created = event();
    const client = await connect(
      mockFetch((req) =>
        req.method === "POST" ? { status: 201, body: created } : { status: 200, body: [created, other] },
      ),
    );

    const r = await call(client, "create_event", {
      title: created.title,
      start: created.start,
      end: created.end,
    });

    expect(r.isError).toBeFalsy();
    expect(r.structuredContent?.conflicts).toEqual([
      { id: other.id, title: other.title, start: other.start, end: other.end },
    ]);
    expect(text(r)).toContain("WARNING: conflicts with 1 event(s)");
    expect(text(r)).toContain(other.id);
  });

  it("end before start: the API error becomes isError with its message, no stack trace", async () => {
    const msg = "Invalid data — end: end must be after start";
    const client = await connect(
      mockFetch(() => ({
        status: 400,
        body: { error: msg, details: [{ field: "end", message: "end must be after start" }] },
      })),
    );

    const r = await call(client, "create_event", {
      title: "x",
      start: "2026-11-20T15:00:00-03:00",
      end: "2026-11-20T14:00:00-03:00",
    });

    expect(r.isError).toBe(true);
    expect(text(r)).toBe(msg);
    expect(text(r)).not.toMatch(/\n\s+at /);
  });

  it("a date without timezone is rejected before calling the API", async () => {
    const f = mockFetch(() => ({ status: 201, body: event() }));
    const client = await connect(f);

    const r = await call(client, "create_event", {
      title: "x",
      start: "2026-11-20T14:00:00",
      end: "2026-11-20T15:00:00-03:00",
    });

    expect(r.isError).toBe(true);
    expect(text(r)).toContain("ISO 8601 with a timezone");
    expect(f).not.toHaveBeenCalled();
  });
});

describe("nonexistent event", () => {
  const api404 = () =>
    mockFetch((req) => ({
      status: 404,
      body: { error: `Event not found with id ${req.path.split("/").pop()}` },
    }));

  it("get_event → isError with a useful message", async () => {
    const client = await connect(api404());
    const r = await call(client, "get_event", { id: MISSING_ID });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(`Event not found with id ${MISSING_ID}. Use list_events to find the correct id.`);
  });

  it("update_event → isError", async () => {
    const client = await connect(api404());
    const r = await call(client, "update_event", { id: MISSING_ID, title: "new" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(`Event not found with id ${MISSING_ID}`);
  });

  it("delete_event → isError and does not call DELETE", async () => {
    const f = api404();
    const client = await connect(f);
    const r = await call(client, "delete_event", { id: MISSING_ID });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(`Event not found with id ${MISSING_ID}`);
    expect(f.mock.calls.map(([, init]) => init?.method)).toEqual(["GET"]);
  });

  it("an id that is not a UUID → isError pointing to list_events", async () => {
    const f = api404();
    const client = await connect(f);
    const r = await call(client, "get_event", { id: "thursday-meeting" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("use list_events");
    expect(f).not.toHaveBeenCalled();
  });
});

describe("check_availability", () => {
  const from = "2026-11-20T14:00:00-03:00";
  const to = "2026-11-20T15:00:00-03:00";

  it("free range", async () => {
    const f = mockFetch(() => ({ status: 200, body: [] }));
    const client = await connect(f);
    const r = await call(client, "check_availability", { from, to });
    expect(r.structuredContent).toEqual({ free: true, from, to, conflicts: [] });
    expect(text(r)).toMatch(/^Free/);
  });

  it("schedule conflict: free=false and lists conflicts with ids", async () => {
    const f = mockFetch((req) => {
      expect(req.query).toEqual({ from, to });
      return { status: 200, body: [event(), other] };
    });
    const client = await connect(f);
    const r = await call(client, "check_availability", { from, to });
    expect(r.structuredContent?.free).toBe(false);
    expect((r.structuredContent?.conflicts as { id: string }[]).map((c) => c.id)).toEqual([event().id, other.id]);
    expect(text(r)).toContain("Busy: 2 conflict(s)");
  });
});

describe("list_events / update_event / delete_event", () => {
  it("list_events forwards the range and returns ids", async () => {
    const from = "2026-11-20T00:00:00-03:00";
    const to = "2026-11-21T00:00:00-03:00";
    const f = mockFetch((req) => {
      expect(req).toMatchObject({ method: "GET", path: "/events", query: { from, to } });
      return { status: 200, body: [event(), other] };
    });
    const client = await connect(f);
    const r = await call(client, "list_events", { from, to });
    expect(r.structuredContent).toMatchObject({ from, to, total: 2 });
    expect(text(r)).toContain(`id ${event().id}`);
    expect(text(r)).toContain(`id ${other.id}`);
  });

  it("update_event sends only the given fields", async () => {
    const updated = event({ title: "Planning (rescheduled)" });
    const f = mockFetch((req) => {
      if (req.method === "PATCH") {
        expect(req.path).toBe(`/events/${updated.id}`);
        expect(req.body).toEqual({ title: updated.title, description: null });
        return { status: 200, body: updated };
      }
      return { status: 200, body: [updated] };
    });
    const client = await connect(f);
    const r = await call(client, "update_event", {
      id: updated.id,
      title: updated.title,
      description: null,
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ event: updated, conflicts: [] });
  });

  it("update_event without fields → isError without calling the API", async () => {
    const f = mockFetch(() => ({ status: 200, body: event() }));
    const client = await connect(f);
    const r = await call(client, "update_event", { id: event().id });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Provide at least one field");
    expect(f).not.toHaveBeenCalled();
  });

  it("delete_event fetches, deletes and returns the deleted event's data", async () => {
    const ev = event();
    const f = mockFetch((req) => (req.method === "DELETE" ? { status: 204 } : { status: 200, body: ev }));
    const client = await connect(f);
    const r = await call(client, "delete_event", { id: ev.id });
    expect(r.structuredContent).toEqual({ deleted: true, event: ev });
    expect(f.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "DELETE"]);
  });
});

describe("infrastructure failures", () => {
  it("404 without a body (URL pointing to another service) → isError telling to check AGENDA_API_URL", async () => {
    const client = await connect(mockFetch(() => ({ status: 404 })));
    const r = await call(client, "get_event", { id: MISSING_ID });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(
      `The API at http://agenda.test responded 404 to GET /events/${MISSING_ID} without an error message. Check that AGENDA_API_URL points to the agenda API.`,
    );
  });

  it("API down → isError explaining how to fix it", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const client = await connect(f);
    const r = await call(client, "list_events", {
      from: "2026-11-20T00:00:00-03:00",
      to: "2026-11-21T00:00:00-03:00",
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Could not connect to the agenda API at http://agenda.test");
    expect(text(r)).toContain("pnpm dev:api");
  });
});

describe("batch", () => {
  /** Fake API: POST /events/batch echoes with ids; GET /events returns created + `existing`. */
  function batchApi(existing: Event[] = []) {
    let created: Event[] = [];
    return mockFetch((req) => {
      if (req.method === "POST" && req.path === "/events/batch") {
        const { events } = req.body as { events: Omit<Event, "id" | "createdAt" | "updatedAt">[] };
        created = events.map((e, i) =>
          event({ ...e, description: e.description ?? null, id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}` }),
        );
        return { status: 201, body: { events: created } };
      }
      if (req.method === "GET" && req.path === "/events") return { status: 200, body: [...existing, ...created] };
      if (req.method === "POST" && req.path === "/events/batch/delete") {
        return { status: 200, body: { deleted: (req.body as { ids: string[] }).ids.length } };
      }
      return { status: 500 };
    });
  }

  const jiuJitsu = {
    title: "Jiu-jitsu",
    weekdays: ["mon", "wed", "fri"],
    startTime: "19:30",
    endTime: "20:30",
    from: "2026-11-20",
    to: "2026-12-31",
  };

  it("create_recurring_events: expands the rule into a single API call", async () => {
    const conflicting = event({
      id: "bbbbbbbb-0000-4000-8000-000000000000",
      title: "Birthday",
      start: "2026-11-25T19:00:00-03:00",
      end: "2026-11-25T20:00:00-03:00",
    });
    const f = batchApi([conflicting]);
    const client = await connect(f);

    const r = await call(client, "create_recurring_events", jiuJitsu);

    expect(r.isError).toBeFalsy();
    const posts = f.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    const sent = JSON.parse(String(posts[0]![1]!.body)).events as { start: string; end: string }[];
    // mon/wed/fri from 2026-11-20 to 2026-12-31: 5 in November + 13 in December
    expect(sent).toHaveLength(18);
    expect(sent[0]).toMatchObject({ start: "2026-11-20T19:30:00-03:00", end: "2026-11-20T20:30:00-03:00" });
    expect(sent[1]!.start).toBe("2026-11-23T19:30:00-03:00");
    expect(sent.at(-1)!.start).toBe("2026-12-30T19:30:00-03:00");

    expect(r.structuredContent?.total).toBe(18);
    const conflicts = r.structuredContent?.conflicts as { occurrence: { start: string }; existing: { title: string } }[];
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      occurrence: { start: "2026-11-25T19:30:00-03:00" },
      existing: { title: "Birthday" },
    });
    expect(text(r)).toContain('Created 18 "Jiu-jitsu" events (mon/wed/fri 19:30–20:30, from 2026-11-20 to 2026-12-31)');
    expect(text(r)).toContain("WARNING: 1 conflict(s)");
  });

  it("create_recurring_events: a long list comes back compact for the model", async () => {
    const client = await connect(batchApi());
    const r = await call(client, "create_recurring_events", { ...jiuJitsu, to: "2027-06-30" });
    expect(r.structuredContent?.total).toBeGreaterThan(30);
    expect(text(r)).toMatch(/… \(\+\d+ events; use list_events/);
  });

  it("create_recurring_events: endTime before startTime → isError without calling the API", async () => {
    const f = batchApi();
    const client = await connect(f);
    const r = await call(client, "create_recurring_events", { ...jiuJitsu, endTime: "19:00" });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("endTime must be after startTime (same day).");
    expect(f).not.toHaveBeenCalled();
  });

  it("create_recurring_events: more than 500 occurrences → isError telling to split", async () => {
    const f = batchApi();
    const client = await connect(f);
    const r = await call(client, "create_recurring_events", {
      ...jiuJitsu,
      weekdays: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
      from: "2026-01-01",
      to: "2027-12-31",
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("That would create 730 events; the maximum is 500 per call. Split the period.");
    expect(f).not.toHaveBeenCalled();
  });

  it("create_events_batch: an item error comes back with its index", async () => {
    const msg = "Invalid data — events.1.end: end must be after start";
    const client = await connect(mockFetch(() => ({ status: 400, body: { error: msg } })));
    const r = await call(client, "create_events_batch", {
      events: [
        { title: "A", start: "2026-11-20T10:00:00-03:00", end: "2026-11-20T11:00:00-03:00" },
        { title: "B", start: "2026-11-20T12:00:00-03:00", end: "2026-11-20T11:00:00-03:00" },
      ],
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(msg);
  });

  it("delete_events_batch: one call with all ids", async () => {
    const f = batchApi();
    const client = await connect(f);
    const ids = [event().id, other.id];
    const r = await call(client, "delete_events_batch", { ids });
    expect(r.structuredContent).toEqual({ deleted: 2 });
    expect(f.mock.calls).toHaveLength(1);
    expect(JSON.parse(String(f.mock.calls[0]![1]!.body))).toEqual({ ids });
  });
});
