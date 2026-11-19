import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import type { CriarEvento, Evento, IntervaloQuery } from "./schemas.js";

interface Linha {
  id: string;
  titulo: string;
  descricao: string | null;
  inicio: string;
  fim: string;
  criado_em: string;
  atualizado_em: string;
}

const paraEvento = (l: Linha): Evento => ({
  id: l.id,
  titulo: l.titulo,
  descricao: l.descricao,
  inicio: l.inicio,
  fim: l.fim,
  criadoEm: l.criado_em,
  atualizadoEm: l.atualizado_em,
});

export type DadosEvento = Pick<Evento, "titulo" | "descricao" | "inicio" | "fim">;

export function criarRepositorio(db: Db) {
  const stmtBuscar = db.prepare<[string], Linha>("SELECT * FROM eventos WHERE id = ?");
  const stmtInserir = db.prepare(`
    INSERT INTO eventos (id, titulo, descricao, inicio, fim, inicio_ms, fim_ms, criado_em, atualizado_em)
    VALUES (@id, @titulo, @descricao, @inicio, @fim, @inicio_ms, @fim_ms, @criado_em, @atualizado_em)
  `);
  const stmtAtualizar = db.prepare(`
    UPDATE eventos
       SET titulo = @titulo, descricao = @descricao, inicio = @inicio, fim = @fim,
           inicio_ms = @inicio_ms, fim_ms = @fim_ms, atualizado_em = @atualizado_em
     WHERE id = @id
  `);
  const stmtRemover = db.prepare<[string]>("DELETE FROM eventos WHERE id = ?");

  const repo = {
    /** Intervalos semiabertos [inicio, fim): eventos que só se tocam na borda não se sobrepõem. */
    listar({ de, ate }: IntervaloQuery): Evento[] {
      const filtros: string[] = [];
      const params: number[] = [];
      if (ate) {
        filtros.push("inicio_ms < ?");
        params.push(Date.parse(ate));
      }
      if (de) {
        filtros.push("fim_ms > ?");
        params.push(Date.parse(de));
      }
      const where = filtros.length ? `WHERE ${filtros.join(" AND ")}` : "";
      return db
        .prepare<number[], Linha>(`SELECT * FROM eventos ${where} ORDER BY inicio_ms, id`)
        .all(...params)
        .map(paraEvento);
    },

    buscar(id: string): Evento | undefined {
      const linha = stmtBuscar.get(id);
      return linha && paraEvento(linha);
    },

    criar(dados: CriarEvento): Evento {
      const agora = new Date().toISOString();
      const id = randomUUID();
      stmtInserir.run({
        id,
        titulo: dados.titulo,
        descricao: dados.descricao ?? null,
        inicio: dados.inicio,
        fim: dados.fim,
        inicio_ms: Date.parse(dados.inicio),
        fim_ms: Date.parse(dados.fim),
        criado_em: agora,
        atualizado_em: agora,
      });
      return repo.buscar(id)!;
    },

    atualizar(id: string, dados: DadosEvento): Evento {
      stmtAtualizar.run({
        id,
        ...dados,
        inicio_ms: Date.parse(dados.inicio),
        fim_ms: Date.parse(dados.fim),
        atualizado_em: new Date().toISOString(),
      });
      return repo.buscar(id)!;
    },

    remover(id: string): boolean {
      return stmtRemover.run(id).changes > 0;
    },

    criarVarios: db.transaction((lista: CriarEvento[]): Evento[] => lista.map((d) => repo.criar(d))),

    /** Ids inexistentes, sem remover nada. */
    inexistentes(ids: string[]): string[] {
      return [...new Set(ids)].filter((id) => !stmtBuscar.get(id));
    },

    removerVarios: db.transaction((ids: string[]): number =>
      [...new Set(ids)].reduce((n, id) => n + stmtRemover.run(id).changes, 0),
    ),
  };
  return repo;
}

export type Repositorio = ReturnType<typeof criarRepositorio>;
