import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openDb, type Db } from "../src/db.js";
import { EventSchema, type Event } from "../src/schemas.js";

let db: Db;
let app: ReturnType<typeof buildApp>;

beforeEach(() => {
  db = openDb(":memory:");
  app = buildApp({ db });
});

afterEach(async () => {
  await app.close();
  db.close();
});

const meeting = {
  title: "Planning meeting",
  description: "Sprint 42",
  start: "2026-11-20T14:00:00-03:00",
  end: "2026-11-20T15:00:00-03:00",
};

async function create(body: Record<string, unknown> = meeting): Promise<Event> {
  const res = await app.inject({ method: "POST", url: "/events", payload: body });
  expect(res.statusCode).toBe(201);
  return res.json();
}

const MISSING_UUID = "00000000-0000-4000-8000-000000000000";

describe("POST /events", () => {
  it("creates a valid event and keeps the date offsets", async () => {
    const ev = await create();
    expect(EventSchema.parse(ev)).toEqual(ev);
    expect(ev).toMatchObject(meeting);
    expect(ev.createdAt).toBe(ev.updatedAt);
  });

  it("description is optional (returns null)", async () => {
    const { description: _, ...withoutDescription } = meeting;
    const ev = await create(withoutDescription);
    expect(ev.description).toBeNull();
  });

  it("400 when end is before start", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/events",
      payload: { ...meeting, start: meeting.end, end: meeting.start },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "Invalid data — end: end must be after start",
      details: [{ field: "end", message: "end must be after start" }],
    });
  });

  it("400 when end equals start", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/events",
      payload: { ...meeting, end: meeting.start },
    });
    expect(res.statusCode).toBe(400);
  });

  it("readable 400 for a date without timezone, a missing field and an unknown field", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/events",
      payload: { start: "2026-11-20T14:00:00", end: meeting.end, room: "room 1" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.details).toEqual(
      expect.arrayContaining([
        { field: "title", message: "required field" },
        { field: "start", message: "must be ISO 8601 with a timezone, e.g. 2026-11-20T15:00:00-03:00" },
        { field: "(body)", message: "unknown field(s): room" },
      ]),
    );
    expect(body.error).toMatch(/^Invalid data — /);
  });

  it("400 for malformed JSON without a stack trace", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/events",
      headers: { "content-type": "application/json" },
      payload: "{title:",
    });
    expect(res.statusCode).toBe(400);
    expect(Object.keys(res.json())).toEqual(["error"]);
    expect(res.body).not.toMatch(/at .*\.js/);
  });
});

describe("GET /events/:id", () => {
  it("returns the event", async () => {
    const ev = await create();
    const res = await app.inject({ method: "GET", url: `/events/${ev.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(ev);
  });

  it("404 for a nonexistent event", async () => {
    const res = await app.inject({ method: "GET", url: `/events/${MISSING_UUID}` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: `Event not found with id ${MISSING_UUID}` });
  });

  it("400 for an id that is not a UUID", async () => {
    const res = await app.inject({ method: "GET", url: "/events/abc" });
    expect(res.statusCode).toBe(400);
    expect(res.json().details).toEqual([{ field: "id", message: "must be a UUID" }]);
  });
});

describe("GET /events?from=&to= (overlap / schedule conflict)", () => {
  async function list(from: string, to: string) {
    const res = await app.inject({ method: "GET", url: "/events", query: { from, to } });
    expect(res.statusCode).toBe(200);
    return (res.json() as Event[]).map((e) => e.title);
  }

  beforeEach(async () => {
    await create({ title: "A 14-15", start: "2026-11-20T14:00:00-03:00", end: "2026-11-20T15:00:00-03:00" });
    await create({ title: "B 16-17", start: "2026-11-20T16:00:00-03:00", end: "2026-11-20T17:00:00-03:00" });
    // 17:00-18:00 at -03:00, sent in UTC
    await create({ title: "C 17-18 (UTC)", start: "2026-11-20T20:00:00Z", end: "2026-11-20T21:00:00Z" });
  });

  it("returns events that partially overlap the range", async () => {
    expect(await list("2026-11-20T14:30:00-03:00", "2026-11-20T16:30:00-03:00")).toEqual(["A 14-15", "B 16-17"]);
  });

  it("compares instants, not strings (different timezones)", async () => {
    // 17:00Z == 14:00-03:00 → matches A, stored at -03:00
    expect(await list("2026-11-20T17:00:00Z", "2026-11-20T17:30:00Z")).toEqual(["A 14-15"]);
    // C was stored in UTC and is found when querying at -03:00
    expect(await list("2026-11-20T17:30:00-03:00", "2026-11-20T18:30:00-03:00")).toEqual(["C 17-18 (UTC)"]);
  });

  it("a range touching the edge does not conflict (half-open)", async () => {
    expect(await list("2026-11-20T15:00:00-03:00", "2026-11-20T16:00:00-03:00")).toEqual([]);
  });

  it("a range containing the whole event", async () => {
    expect(await list("2026-11-20T00:00:00-03:00", "2026-11-21T00:00:00-03:00")).toHaveLength(3);
  });

  it("without filters lists everything ordered by start", async () => {
    const res = await app.inject({ method: "GET", url: "/events" });
    expect((res.json() as Event[]).map((e) => e.title)).toEqual(["A 14-15", "B 16-17", "C 17-18 (UTC)"]);
  });

  it("400 when to is before from", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/events",
      query: { from: "2026-11-20T15:00:00-03:00", to: "2026-11-20T14:00:00-03:00" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid data — to: to must be after from");
  });
});

describe("PATCH /events/:id", () => {
  it("partially updates and changes updatedAt", async () => {
    const ev = await create();
    await new Promise((r) => setTimeout(r, 5));
    const res = await app.inject({
      method: "PATCH",
      url: `/events/${ev.id}`,
      payload: { title: "Planning (rescheduled)", end: "2026-11-20T15:30:00-03:00" },
    });
    expect(res.statusCode).toBe(200);
    const updated: Event = res.json();
    expect(updated).toMatchObject({
      id: ev.id,
      title: "Planning (rescheduled)",
      description: "Sprint 42",
      start: meeting.start,
      end: "2026-11-20T15:30:00-03:00",
      createdAt: ev.createdAt,
    });
    expect(updated.updatedAt > ev.updatedAt).toBe(true);
  });

  it("description: null clears the field", async () => {
    const ev = await create();
    const res = await app.inject({ method: "PATCH", url: `/events/${ev.id}`, payload: { description: null } });
    expect(res.json().description).toBeNull();
  });

  it("400 when the merged result leaves end before start", async () => {
    const ev = await create();
    const res = await app.inject({
      method: "PATCH",
      url: `/events/${ev.id}`,
      payload: { start: "2026-11-20T16:00:00-03:00" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("end must be after start");
  });

  it("400 for an empty body", async () => {
    const ev = await create();
    const res = await app.inject({ method: "PATCH", url: `/events/${ev.id}`, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("provide at least one field");
  });

  it("404 for a nonexistent event", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/events/${MISSING_UUID}`,
      payload: { title: "x" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe(`Event not found with id ${MISSING_UUID}`);
  });
});

describe("DELETE /events/:id", () => {
  it("deletes and then returns 404", async () => {
    const ev = await create();
    expect((await app.inject({ method: "DELETE", url: `/events/${ev.id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/events/${ev.id}` })).statusCode).toBe(404);
  });

  it("404 for a nonexistent event", async () => {
    const res = await app.inject({ method: "DELETE", url: `/events/${MISSING_UUID}` });
    expect(res.statusCode).toBe(404);
  });
});

describe("batch", () => {
  const ev = (day: number, title = "Jiu-jitsu") => ({
    title,
    start: `2026-12-${String(day).padStart(2, "0")}T19:30:00-03:00`,
    end: `2026-12-${String(day).padStart(2, "0")}T20:30:00-03:00`,
  });

  it("POST /events/batch creates all and returns the ids", async () => {
    const res = await app.inject({ method: "POST", url: "/events/batch", payload: { events: [ev(1), ev(3), ev(5)] } });
    expect(res.statusCode).toBe(201);
    const { events } = res.json() as { events: Event[] };
    expect(events).toHaveLength(3);
    expect(new Set(events.map((e) => e.id)).size).toBe(3);
    const all = await app.inject({ method: "GET", url: "/events" });
    expect(all.json()).toHaveLength(3);
  });

  it("POST /events/batch is atomic: one invalid item → 400 with the index and nothing created", async () => {
    const bad = { ...ev(3), end: ev(3).start };
    const res = await app.inject({ method: "POST", url: "/events/batch", payload: { events: [ev(1), bad] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().details).toEqual([{ field: "events.1.end", message: "end must be after start" }]);
    expect((await app.inject({ method: "GET", url: "/events" })).json()).toEqual([]);
  });

  it("POST /events/batch rejects an empty list", async () => {
    const res = await app.inject({ method: "POST", url: "/events/batch", payload: { events: [] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("provide at least 1 event");
  });

  it("POST /events/batch/delete deletes all", async () => {
    const created = (
      await app.inject({ method: "POST", url: "/events/batch", payload: { events: [ev(1), ev(3), ev(5, "Other")] } })
    ).json().events as Event[];
    const ids = created.filter((e) => e.title === "Jiu-jitsu").map((e) => e.id);
    const res = await app.inject({ method: "POST", url: "/events/batch/delete", payload: { ids } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 2 });
    expect(((await app.inject({ method: "GET", url: "/events" })).json() as Event[]).map((e) => e.title)).toEqual([
      "Other",
    ]);
  });

  it("POST /events/batch/delete is atomic: missing id → 404 and nothing deleted", async () => {
    const [a] = (await app.inject({ method: "POST", url: "/events/batch", payload: { events: [ev(1)] } })).json()
      .events as Event[];
    const res = await app.inject({
      method: "POST",
      url: "/events/batch/delete",
      payload: { ids: [a!.id, MISSING_UUID] },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe(`No events were deleted: 1 id(s) not found: ${MISSING_UUID}`);
    expect((await app.inject({ method: "GET", url: "/events" })).json()).toHaveLength(1);
  });
});
