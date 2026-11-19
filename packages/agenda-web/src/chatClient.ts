import type { ChatEvent } from "@agenda/chat/events";
import { nowContext } from "./dates.ts";

/** POST that answers with SSE (EventSource only does GET, so we read the fetch stream). */
async function postSse(url: string, body: object, onEvent: (e: ChatEvent) => void): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, ...nowContext() }),
    });
  } catch {
    onEvent({ type: "error", message: "Chat server unreachable. Is it running? (pnpm dev:chat)" });
    onEvent({ type: "done" });
    return;
  }

  if (!res.ok || !res.body) {
    let msg = `The chat server responded ${res.status}.`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      if (res.status === 502 || res.status === 504) msg = "Chat server is down (pnpm dev:chat).";
    }
    onEvent({ type: "error", message: msg });
    onEvent({ type: "done" });
    return;
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const line = block.split("\n").find((l) => l.startsWith("data: "));
      if (line) onEvent(JSON.parse(line.slice(6)) as ChatEvent);
    }
  }
}

export const sendMessage = (conversationId: string | undefined, text: string, onEvent: (e: ChatEvent) => void) =>
  postSse("/chat", { conversationId, text }, onEvent);

export const answerConfirmation = (
  conversationId: string,
  callId: string,
  approved: boolean,
  onEvent: (e: ChatEvent) => void,
) => postSse("/chat/confirm", { conversationId, callId, approved }, onEvent);
