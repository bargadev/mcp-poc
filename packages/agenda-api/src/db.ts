import Database from "better-sqlite3";

export type Db = Database.Database;

export function openDb(path: string = process.env.AGENDA_DB ?? "agenda.db"): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      description TEXT,
      starts_at   TEXT NOT NULL,
      ends_at     TEXT NOT NULL,
      starts_ms   INTEGER NOT NULL,
      ends_ms     INTEGER NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      CHECK (ends_ms > starts_ms)
    );
    CREATE INDEX IF NOT EXISTS idx_events_range ON events (starts_ms, ends_ms);
  `);
  return db;
}
