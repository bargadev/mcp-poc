import type { EventoChat } from "@agenda/chat/eventos";
import { contextoAgora } from "./datas.ts";

/** POST que responde em SSE (EventSource só faz GET, então lemos o stream do fetch). */
async function postSse(url: string, body: object, onEvento: (e: EventoChat) => void): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, ...contextoAgora() }),
    });
  } catch {
    onEvento({ tipo: "erro", mensagem: "Servidor de chat inacessível. Ele está rodando? (pnpm dev:chat)" });
    onEvento({ tipo: "fim" });
    return;
  }

  if (!res.ok || !res.body) {
    let msg = `O servidor de chat respondeu ${res.status}.`;
    try {
      const j = (await res.json()) as { erro?: string };
      if (j.erro) msg = j.erro;
    } catch {
      if (res.status === 502 || res.status === 504) msg = "Servidor de chat fora do ar (pnpm dev:chat).";
    }
    onEvento({ tipo: "erro", mensagem: msg });
    onEvento({ tipo: "fim" });
    return;
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let corte: number;
    while ((corte = buffer.indexOf("\n\n")) >= 0) {
      const bloco = buffer.slice(0, corte);
      buffer = buffer.slice(corte + 2);
      const linha = bloco.split("\n").find((l) => l.startsWith("data: "));
      if (linha) onEvento(JSON.parse(linha.slice(6)) as EventoChat);
    }
  }
}

export const enviarMensagem = (conversaId: string | undefined, texto: string, onEvento: (e: EventoChat) => void) =>
  postSse("/chat", { conversaId, texto }, onEvento);

export const responderConfirmacao = (
  conversaId: string,
  callId: string,
  aprovado: boolean,
  onEvento: (e: EventoChat) => void,
) => postSse("/chat/confirmar", { conversaId, callId, aprovado }, onEvento);
