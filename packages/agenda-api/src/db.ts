import Database from "better-sqlite3";

export type Db = Database.Database;

export function abrirDb(caminho: string = process.env.AGENDA_DB ?? "agenda.db"): Db {
  const db = new Database(caminho);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS eventos (
      id            TEXT PRIMARY KEY,
      titulo        TEXT NOT NULL,
      descricao     TEXT,
      inicio        TEXT NOT NULL,
      fim           TEXT NOT NULL,
      inicio_ms     INTEGER NOT NULL,
      fim_ms        INTEGER NOT NULL,
      criado_em     TEXT NOT NULL,
      atualizado_em TEXT NOT NULL,
      CHECK (fim_ms > inicio_ms)
    );
    CREATE INDEX IF NOT EXISTS idx_eventos_intervalo ON eventos (inicio_ms, fim_ms);
  `);
  return db;
}
