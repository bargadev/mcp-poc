import OpenAI from "openai";
import { createAgent } from "./agent.js";
import { buildChatApp } from "./app.js";
import { config } from "./config.js";
import { connectMcp } from "./mcp.js";

const openai = new OpenAI({ apiKey: config.openaiKey() });
const mcp = await connectMcp(config.apiUrl);

const agent = createAgent({
  createResponse: (params) => openai.responses.create(params),
  mcp,
  model: config.model,
  effort: config.effort,
});

const app = buildChatApp({ agent, model: config.model });

const shutdown = async () => {
  await app.close();
  await mcp.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.port, host: config.host });
app.log.info(`model ${config.model} (effort ${config.effort}) · MCP → API ${config.apiUrl}`);
