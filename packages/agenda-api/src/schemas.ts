import { z } from "zod";

export const FORMATO_DATA_EXEMPLO = "2026-11-20T15:00:00-03:00";

const MSG_OBRIGATORIO = "campo obrigatório";

/** ISO 8601 com timezone obrigatório (Z ou ±hh:mm). */
export const DataHora = z.iso.datetime({
  offset: true,
  error: (iss) =>
    iss.input === undefined
      ? MSG_OBRIGATORIO
      : `deve estar em ISO 8601 com timezone, ex: ${FORMATO_DATA_EXEMPLO}`,
});

const Titulo = z
  .string({ error: (iss) => (iss.input === undefined ? MSG_OBRIGATORIO : "deve ser texto") })
  .trim()
  .min(1, "não pode ser vazio")
  .max(200, "deve ter no máximo 200 caracteres");

const Descricao = z
  .string({ error: "deve ser texto" })
  .trim()
  .max(2000, "deve ter no máximo 2000 caracteres");

export const fimDepoisDeInicio = (inicio: string, fim: string): boolean =>
  Date.parse(fim) > Date.parse(inicio);

export const MSG_FIM_ANTES_INICIO = "fim deve ser depois de inicio";

export const CriarEventoSchema = z
  .strictObject({
    titulo: Titulo,
    descricao: Descricao.optional(),
    inicio: DataHora,
    fim: DataHora,
  })
  .refine((v) => fimDepoisDeInicio(v.inicio, v.fim), {
    message: MSG_FIM_ANTES_INICIO,
    path: ["fim"],
  });

/**
 * Atualização parcial. `descricao: null` limpa o campo.
 * A regra fim > inicio é validada após o merge com o evento atual (ver app.ts).
 */
export const AtualizarEventoSchema = z
  .strictObject({
    titulo: Titulo.optional(),
    descricao: Descricao.nullable().optional(),
    inicio: DataHora.optional(),
    fim: DataHora.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "informe ao menos um campo para atualizar (titulo, descricao, inicio, fim)",
  });

export const IntervaloQuerySchema = z
  .object({
    de: DataHora.optional(),
    ate: DataHora.optional(),
  })
  .refine((v) => !v.de || !v.ate || fimDepoisDeInicio(v.de, v.ate), {
    message: "ate deve ser depois de de",
    path: ["ate"],
  });

export const IdParamSchema = z.object({
  id: z.uuid({ error: "deve ser um UUID" }),
});

export const EventoSchema = z.object({
  id: z.uuid(),
  titulo: z.string(),
  descricao: z.string().nullable(),
  /** Preservado com o offset enviado na criação/atualização. */
  inicio: DataHora,
  fim: DataHora,
  /** UTC. */
  criadoEm: z.iso.datetime(),
  atualizadoEm: z.iso.datetime(),
});

export const ErroApiSchema = z.object({
  erro: z.string(),
  detalhes: z.array(z.object({ campo: z.string(), mensagem: z.string() })).optional(),
});

export const MAX_LOTE = 500;

/** Criação em lote: atômica (ou cria todos, ou nenhum). */
export const CriarEventosLoteSchema = z.strictObject({
  eventos: z
    .array(CriarEventoSchema)
    .min(1, "informe ao menos 1 evento")
    .max(MAX_LOTE, `no máximo ${MAX_LOTE} eventos por lote`),
});

/** Remoção em lote: atômica (se algum id não existir, nada é removido). */
export const RemoverEventosLoteSchema = z.strictObject({
  ids: z
    .array(z.uuid({ error: "deve ser um UUID" }))
    .min(1, "informe ao menos 1 id")
    .max(MAX_LOTE, `no máximo ${MAX_LOTE} ids por lote`),
});

export type Evento = z.infer<typeof EventoSchema>;
export type CriarEvento = z.infer<typeof CriarEventoSchema>;
export type AtualizarEvento = z.infer<typeof AtualizarEventoSchema>;
export type IntervaloQuery = z.infer<typeof IntervaloQuerySchema>;
export type ErroApi = z.infer<typeof ErroApiSchema>;
export type CriarEventosLote = z.infer<typeof CriarEventosLoteSchema>;
export type RemoverEventosLote = z.infer<typeof RemoverEventosLoteSchema>;
