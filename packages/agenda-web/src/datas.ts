const pad = (n: number) => String(n).padStart(2, "0");

/** ISO 8601 local com offset, ex: 2026-11-19T10:30:00-03:00 */
export function isoLocal(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sinal = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sinal}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export const fusoLocal = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function contextoAgora() {
  return { agora: isoLocal(new Date()), fuso: fusoLocal() };
}

/** "14h", "9h30" */
export function hora(d: Date | string): string {
  const x = typeof d === "string" ? new Date(d) : d;
  return x.getMinutes() ? `${x.getHours()}h${pad(x.getMinutes())}` : `${x.getHours()}h`;
}

/** "sex, 21/11" */
export function dia(d: Date | string): string {
  const x = typeof d === "string" ? new Date(d) : d;
  const semana = new Intl.DateTimeFormat("pt-BR", { weekday: "short" }).format(x).replace(".", "");
  return `${semana}, ${pad(x.getDate())}/${pad(x.getMonth() + 1)}`;
}

export function intervalo(inicio: Date | string, fim: Date | string): string {
  return `${dia(inicio)} ${hora(inicio)}–${hora(fim)}`;
}
