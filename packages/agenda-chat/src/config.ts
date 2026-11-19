import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// .env da raiz do monorepo (opcional, gitignored).
const envRaiz = resolve(RAIZ, ".env");
if (existsSync(envRaiz)) process.loadEnvFile(envRaiz);

/**
 * OPENAI_API_KEY vem do ambiente ou, se ausente, de OPENAI_ENV_FILE (o .env de outro
 * projeto). Desse arquivo só a OPENAI_API_KEY é lida; o resto é ignorado.
 */
function chaveOpenAI(): string {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const arquivo = process.env.OPENAI_ENV_FILE;
  if (arquivo) {
    if (!existsSync(arquivo)) throw new Error(`OPENAI_ENV_FILE aponta para um arquivo inexistente: ${arquivo}`);
    const chave = parseEnv(readFileSync(arquivo, "utf8")).OPENAI_API_KEY;
    if (chave) return chave;
    throw new Error(`OPENAI_ENV_FILE (${arquivo}) não define OPENAI_API_KEY`);
  }
  throw new Error(
    "Defina OPENAI_API_KEY ou OPENAI_ENV_FILE (caminho de um .env que contenha OPENAI_API_KEY). Ver .env.example.",
  );
}

const esforcos = ["minimal", "low", "medium", "high"] as const;
type Esforco = (typeof esforcos)[number];
const esforcoEnv = process.env.OPENAI_REASONING_EFFORT;

export const config = {
  porta: Number(process.env.CHAT_PORT ?? 3003),
  host: process.env.CHAT_HOST ?? "127.0.0.1",
  apiUrl: process.env.AGENDA_API_URL ?? "http://localhost:3002",
  modelo: process.env.OPENAI_MODEL ?? "gpt-5.5",
  esforco: (esforcos as readonly string[]).includes(esforcoEnv ?? "") ? (esforcoEnv as Esforco) : ("low" as Esforco),
  chaveOpenAI,
};
