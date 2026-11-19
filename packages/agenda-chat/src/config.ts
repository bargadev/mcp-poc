import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// Monorepo root .env (optional, gitignored).
const rootEnv = resolve(ROOT, ".env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

/**
 * OPENAI_API_KEY comes from the environment or, if missing, from OPENAI_ENV_FILE (another
 * project's .env). Only OPENAI_API_KEY is read from that file; everything else is ignored.
 */
function openaiKey(): string {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const file = process.env.OPENAI_ENV_FILE;
  if (file) {
    if (!existsSync(file)) throw new Error(`OPENAI_ENV_FILE points to a file that does not exist: ${file}`);
    const key = parseEnv(readFileSync(file, "utf8")).OPENAI_API_KEY;
    if (key) return key;
    throw new Error(`OPENAI_ENV_FILE (${file}) does not define OPENAI_API_KEY`);
  }
  throw new Error("Set OPENAI_API_KEY or OPENAI_ENV_FILE (path to a .env containing OPENAI_API_KEY). See .env.example.");
}

const efforts = ["minimal", "low", "medium", "high"] as const;
type Effort = (typeof efforts)[number];
const effortEnv = process.env.OPENAI_REASONING_EFFORT;

export const config = {
  port: Number(process.env.CHAT_PORT ?? 3003),
  host: process.env.CHAT_HOST ?? "127.0.0.1",
  apiUrl: process.env.AGENDA_API_URL ?? "http://localhost:3002",
  model: process.env.OPENAI_MODEL ?? "gpt-5.5",
  effort: (efforts as readonly string[]).includes(effortEnv ?? "") ? (effortEnv as Effort) : ("low" as Effort),
  openaiKey,
};
