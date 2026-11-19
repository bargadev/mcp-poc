const pad = (n: number) => String(n).padStart(2, "0");

/** Local ISO 8601 with offset, e.g. 2026-11-19T10:30:00-03:00 */
export function localIso(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function nowContext() {
  return { now: localIso(new Date()), timeZone: localTimeZone() };
}

const toDate = (d: Date | string) => (typeof d === "string" ? new Date(d) : d);

/** "2pm", "9:30am" */
export function time(d: Date | string): string {
  const x = toDate(d);
  const h = x.getHours() % 12 || 12;
  const suffix = x.getHours() < 12 ? "am" : "pm";
  return x.getMinutes() ? `${h}:${pad(x.getMinutes())}${suffix}` : `${h}${suffix}`;
}

/** "Fri, Nov 21" */
export function day(d: Date | string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(toDate(d));
}

export function range(start: Date | string, end: Date | string): string {
  return `${day(start)} ${time(start)}–${time(end)}`;
}
