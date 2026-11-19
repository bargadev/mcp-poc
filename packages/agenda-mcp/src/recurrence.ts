import type { CreateEvent } from "@agenda/api/schemas";

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface Recurrence {
  title: string;
  description?: string;
  weekdays: Weekday[];
  /** "HH:MM" */
  startTime: string;
  /** "HH:MM", after startTime (same day) */
  endTime: string;
  /** "YYYY-MM-DD", inclusive */
  from: string;
  /** "YYYY-MM-DD", inclusive */
  to: string;
  /** Fixed offset, e.g. "-03:00" (Brazil has had no daylight saving time since 2019). */
  offset: string;
}

const DAY_MS = 86_400_000;

function utcDate(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

/**
 * Expands a weekly rule into individual events (the API does not store recurrence:
 * each occurrence becomes an independent event).
 */
export function expandRecurrence(r: Recurrence): CreateEvent[] {
  const days = new Set(r.weekdays.map((d) => WEEKDAYS.indexOf(d)));
  const events: CreateEvent[] = [];
  for (let t = utcDate(r.from); t <= utcDate(r.to); t += DAY_MS) {
    const day = new Date(t);
    if (!days.has(day.getUTCDay())) continue;
    const ymd = day.toISOString().slice(0, 10);
    events.push({
      title: r.title,
      ...(r.description ? { description: r.description } : {}),
      start: `${ymd}T${r.startTime}:00${r.offset}`,
      end: `${ymd}T${r.endTime}:00${r.offset}`,
    });
  }
  return events;
}
