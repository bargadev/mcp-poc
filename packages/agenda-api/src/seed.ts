/**
 * Popula a API (já rodando) com 3 eventos relativos à data de hoje.
 * Usa a própria API via HTTP, como faria um cliente real.
 *
 *   AGENDA_API_URL=http://localhost:3002 pnpm seed
 */
import type { CriarEvento, Evento } from "./schemas.js";

const baseUrl = process.env.AGENDA_API_URL ?? "http://localhost:3002";
const OFFSET = process.env.SEED_OFFSET ?? "-03:00";

/** Data local (no offset do seed) daqui a `dias`, às `hora`:`min`. */
function em(dias: number, hora: number, min = 0): string {
  const [sinal, hh, mm] = [OFFSET[0], Number(OFFSET.slice(1, 3)), Number(OFFSET.slice(4, 6))];
  const offsetMin = (sinal === "-" ? -1 : 1) * (hh * 60 + mm);
  const agoraLocal = new Date(Date.now() + offsetMin * 60_000);
  agoraLocal.setUTCDate(agoraLocal.getUTCDate() + dias);
  const pad = (n: number) => String(n).padStart(2, "0");
  const data = `${agoraLocal.getUTCFullYear()}-${pad(agoraLocal.getUTCMonth() + 1)}-${pad(agoraLocal.getUTCDate())}`;
  return `${data}T${pad(hora)}:${pad(min)}:00${OFFSET}`;
}

const eventos: CriarEvento[] = [
  {
    titulo: "Daily do time",
    descricao: "Alinhamento diário, 15 minutos",
    inicio: em(1, 9, 30),
    fim: em(1, 9, 45),
  },
  {
    titulo: "Almoço com cliente",
    descricao: "Restaurante perto do escritório",
    inicio: em(1, 12, 0),
    fim: em(1, 13, 30),
  },
  {
    titulo: "Revisão de arquitetura",
    inicio: em(3, 15, 0),
    fim: em(3, 16, 0),
  },
];

for (const ev of eventos) {
  const res = await fetch(`${baseUrl}/eventos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ev),
  }).catch(() => {
    console.error(`API de agenda inacessível em ${baseUrl}. Suba com: pnpm dev:api`);
    process.exit(1);
  });
  if (!res.ok) {
    console.error(`Falha ao criar "${ev.titulo}": ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const criado = (await res.json()) as Evento;
  console.log(`✔ ${criado.titulo}  ${criado.inicio} → ${criado.fim}  (id ${criado.id})`);
}
