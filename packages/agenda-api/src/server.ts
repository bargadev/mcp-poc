import { buildApp } from "./app.js";
import { abrirDb } from "./db.js";

const port = Number(process.env.PORT ?? 3002);
const host = process.env.HOST ?? "127.0.0.1";

const app = buildApp({ db: abrirDb(), logger: { level: process.env.LOG_LEVEL ?? "info" } });

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
