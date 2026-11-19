/**
 * Seeds the (already running) API with 3 events relative to today.
 * Goes through the API over HTTP, like a real client would.
 *
 *   AGENDA_API_URL=http://localhost:3002 pnpm seed
 */
import type { CreateEvent, Event } from "./schemas.js";

const baseUrl = process.env.AGENDA_API_URL ?? "http://localhost:3002";
const OFFSET = process.env.SEED_OFFSET ?? "-03:00";

/** Local date (in the seed offset) `days` from now, at `hour`:`min`. */
function at(days: number, hour: number, min = 0): string {
  const [sign, hh, mm] = [OFFSET[0], Number(OFFSET.slice(1, 3)), Number(OFFSET.slice(4, 6))];
  const offsetMin = (sign === "-" ? -1 : 1) * (hh * 60 + mm);
  const nowLocal = new Date(Date.now() + offsetMin * 60_000);
  nowLocal.setUTCDate(nowLocal.getUTCDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${nowLocal.getUTCFullYear()}-${pad(nowLocal.getUTCMonth() + 1)}-${pad(nowLocal.getUTCDate())}`;
  return `${date}T${pad(hour)}:${pad(min)}:00${OFFSET}`;
}

const events: CreateEvent[] = [
  {
    title: "Team daily",
    description: "Daily sync, 15 minutes",
    start: at(1, 9, 30),
    end: at(1, 9, 45),
  },
  {
    title: "Lunch with client",
    description: "Restaurant near the office",
    start: at(1, 12, 0),
    end: at(1, 13, 30),
  },
  {
    title: "Architecture review",
    start: at(3, 15, 0),
    end: at(3, 16, 0),
  },
];

for (const ev of events) {
  const res = await fetch(`${baseUrl}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ev),
  }).catch(() => {
    console.error(`Agenda API unreachable at ${baseUrl}. Start it with: pnpm dev:api`);
    process.exit(1);
  });
  if (!res.ok) {
    console.error(`Failed to create "${ev.title}": ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const created = (await res.json()) as Event;
  console.log(`✔ ${created.title}  ${created.start} → ${created.end}  (id ${created.id})`);
}
