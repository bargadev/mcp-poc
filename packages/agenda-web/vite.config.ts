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
      // The calendar reads agenda-api directly, for display only.
      "/api": { target: API, rewrite: (p) => p.replace(/^\/api/, "") },
      // Every action goes through the chat (agenda-chat → OpenAI + MCP).
      "/chat": { target: CHAT },
    },
  },
});
