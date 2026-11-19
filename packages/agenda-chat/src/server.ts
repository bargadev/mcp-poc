import OpenAI from "openai";
import { criarAgente } from "./agente.js";
import { buildChatApp } from "./app.js";
import { config } from "./config.js";
import { conectarMcp } from "./mcp.js";

const openai = new OpenAI({ apiKey: config.chaveOpenAI() });
const mcp = await conectarMcp(config.apiUrl);

const agente = criarAgente({
  criarResposta: (params) => openai.responses.create(params),
  mcp,
  modelo: config.modelo,
  esforco: config.esforco,
});

const app = buildChatApp({ agente, modelo: config.modelo });

const encerrar = async () => {
  await app.close();
  await mcp.close();
  process.exit(0);
};
process.on("SIGINT", encerrar);
process.on("SIGTERM", encerrar);

await app.listen({ port: config.porta, host: config.host });
app.log.info(`modelo ${config.modelo} (esforço ${config.esforco}) · MCP → API ${config.apiUrl}`);
