import type { CriarEvento } from "@agenda/api/schemas";

export const DIAS_SEMANA = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"] as const;
export type DiaSemana = (typeof DIAS_SEMANA)[number];

export interface Recorrencia {
  titulo: string;
  descricao?: string;
  diasDaSemana: DiaSemana[];
  /** "HH:MM" */
  horaInicio: string;
  /** "HH:MM", depois de horaInicio (mesmo dia) */
  horaFim: string;
  /** "YYYY-MM-DD", inclusivo */
  de: string;
  /** "YYYY-MM-DD", inclusivo */
  ate: string;
  /** Offset fixo, ex: "-03:00" (o Brasil não tem horário de verão desde 2019). */
  offset: string;
}

const DIA_MS = 86_400_000;

function dataUtc(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

/**
 * Expande uma regra semanal em eventos individuais (a API não guarda recorrência:
 * cada ocorrência vira um evento independente).
 */
export function expandirRecorrencia(r: Recorrencia): CriarEvento[] {
  const dias = new Set(r.diasDaSemana.map((d) => DIAS_SEMANA.indexOf(d)));
  const eventos: CriarEvento[] = [];
  for (let t = dataUtc(r.de); t <= dataUtc(r.ate); t += DIA_MS) {
    const dia = new Date(t);
    if (!dias.has(dia.getUTCDay())) continue;
    const ymd = dia.toISOString().slice(0, 10);
    eventos.push({
      titulo: r.titulo,
      ...(r.descricao ? { descricao: r.descricao } : {}),
      inicio: `${ymd}T${r.horaInicio}:00${r.offset}`,
      fim: `${ymd}T${r.horaFim}:00${r.offset}`,
    });
  }
  return eventos;
}
