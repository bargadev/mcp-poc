import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const API = process.env.AGENDA_API_URL ?? "http://localhost:3002";
const CHAT = process.env.AGENDA_CHAT_URL ?? "http://localhost:3003";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5174),
    strictPort: true,
    proxy: {
      // O calendário lê a agenda-api direto, só para exibir.
      "/api": { target: API, rewrite: (p) => p.replace(/^\/api/, "") },
      // Toda ação passa pelo chat (agenda-chat → OpenAI + MCP).
      "/chat": { target: CHAT },
    },
  },
});
