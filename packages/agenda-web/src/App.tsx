import { useCallback, useEffect, useRef, useState } from "react";
import { Calendario, type CalendarioHandle } from "./Calendario.tsx";
import { Chat } from "./Chat.tsx";
import { dia, hora, intervalo } from "./datas.ts";

type Status = { estado: "carregando" } | { estado: "ok"; modelo?: string } | { estado: "offline" };

export function App() {
  const cal = useRef<CalendarioHandle>(null);
  const [destaque, setDestaque] = useState<string>();
  const [prefill, setPrefill] = useState<{ texto: string; n: number }>();
  const [status, setStatus] = useState<Status>({ estado: "carregando" });
  const limparDestaque = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    let vivo = true;
    const checar = () =>
      fetch("/chat/health")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
        .then((j: { modelo?: string }) => vivo && setStatus({ estado: "ok", modelo: j.modelo }))
        .catch(() => vivo && setStatus({ estado: "offline" }));
    void checar();
    const t = setInterval(checar, 10_000);
    return () => {
      vivo = false;
      clearInterval(t);
    };
  }, []);

  const aoMutar = useCallback((_nome: string, dados: Record<string, unknown> | undefined) => {
    const ev = dados?.evento as { id: string; inicio: string } | undefined;
    if (ev && _nome !== "remover_evento") {
      setDestaque(ev.id);
      cal.current?.irPara(ev.inicio);
      clearTimeout(limparDestaque.current);
      limparDestaque.current = setTimeout(() => setDestaque(undefined), 6000);
    }
    cal.current?.recarregar();
  }, []);

  const preencher = (texto: string) => setPrefill((p) => ({ texto, n: (p?.n ?? 0) + 1 }));

  return (
    <div className="app">
      <header className="topo">
        <div className="marca">
          <span className="marca-icone" aria-hidden="true" />
          <h1>Agenda</h1>
        </div>
        <div className={`status ${status.estado}`}>
          <span className="ponto" aria-hidden="true" />
          {status.estado === "ok" && <>assistente via MCP · {status.modelo ?? "OpenAI"}</>}
          {status.estado === "offline" && <>assistente offline — rode pnpm dev:chat</>}
          {status.estado === "carregando" && <>conectando…</>}
        </div>
      </header>
      <main className="corpo">
        <Calendario
          ref={cal}
          destaque={destaque}
          onSelecionarIntervalo={(inicio, fim) =>
            preencher(`Marca um evento ${dia(inicio)} das ${hora(inicio)} às ${hora(fim)}: `)
          }
          onClicarEvento={(ev) => preencher(`Sobre “${ev.titulo}” (${intervalo(ev.inicio, ev.fim)}): `)}
        />
        <Chat prefill={prefill} onMutacao={aoMutar} />
      </main>
    </div>
  );
}
