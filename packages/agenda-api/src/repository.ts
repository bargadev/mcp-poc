import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import type { CreateEvent, Event, RangeQuery } from "./schemas.js";

interface Row {
  id: string;
  title: string;
  description: string | null;
  starts_at: string;
  ends_at: string;
  created_at: string;
  updated_at: string;
}

const toEvent = (r: Row): Event => ({
  id: r.id,
  title: r.title,
  description: r.description,
  start: r.starts_at,
  end: r.ends_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export type EventData = Pick<Event, "title" | "description" | "start" | "end">;

export function createRepository(db: Db) {
  const stmtGet = db.prepare<[string], Row>("SELECT * FROM events WHERE id = ?");
  const stmtInsert = db.prepare(`
    INSERT INTO events (id, title, description, starts_at, ends_at, starts_ms, ends_ms, created_at, updated_at)
    VALUES (@id, @title, @description, @starts_at, @ends_at, @starts_ms, @ends_ms, @created_at, @updated_at)
  `);
  const stmtUpdate = db.prepare(`
    UPDATE events
       SET title = @title, description = @description, starts_at = @starts_at, ends_at = @ends_at,
           starts_ms = @starts_ms, ends_ms = @ends_ms, updated_at = @updated_at
     WHERE id = @id
  `);
  const stmtDelete = db.prepare<[string]>("DELETE FROM events WHERE id = ?");

  const repo = {
    /** Half-open intervals [start, end): events that only touch at the edge do not overlap. */
    list({ from, to }: RangeQuery): Event[] {
      const filters: string[] = [];
      const params: number[] = [];
      if (to) {
        filters.push("starts_ms < ?");
        params.push(Date.parse(to));
      }
      if (from) {
        filters.push("ends_ms > ?");
        params.push(Date.parse(from));
      }
      const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
      return db
        .prepare<number[], Row>(`SELECT * FROM events ${where} ORDER BY starts_ms, id`)
        .all(...params)
        .map(toEvent);
    },

    get(id: string): Event | undefined {
      const row = stmtGet.get(id);
      return row && toEvent(row);
    },

    create(data: CreateEvent): Event {
      const now = new Date().toISOString();
      const id = randomUUID();
      stmtInsert.run({
        id,
        title: data.title,
        description: data.description ?? null,
        starts_at: data.start,
        ends_at: data.end,
        starts_ms: Date.parse(data.start),
        ends_ms: Date.parse(data.end),
        created_at: now,
        updated_at: now,
      });
      return repo.get(id)!;
    },

    update(id: string, data: EventData): Event {
      stmtUpdate.run({
        id,
        title: data.title,
        description: data.description,
        starts_at: data.start,
        ends_at: data.end,
        starts_ms: Date.parse(data.start),
        ends_ms: Date.parse(data.end),
        updated_at: new Date().toISOString(),
      });
      return repo.get(id)!;
    },

    delete(id: string): boolean {
      return stmtDelete.run(id).changes > 0;
    },

    createMany: db.transaction((list: CreateEvent[]): Event[] => list.map((d) => repo.create(d))),

    /** Ids that do not exist, without deleting anything. */
    missing(ids: string[]): string[] {
      return [...new Set(ids)].filter((id) => !stmtGet.get(id));
    },

    deleteMany: db.transaction((ids: string[]): number =>
      [...new Set(ids)].reduce((n, id) => n + stmtDelete.run(id).changes, 0),
    ),
  };
  return repo;
}

export type Repository = ReturnType<typeof createRepository>;
