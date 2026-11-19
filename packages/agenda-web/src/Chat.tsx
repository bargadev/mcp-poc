import type { EventoChat } from "@agenda/chat/eventos";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { enviarMensagem, responderConfirmacao } from "./chatClient.ts";
import { dia, hora, intervalo } from "./datas.ts";
import { Texto } from "./Texto.tsx";

type Dados = Record<string, unknown> | undefined;

type Item =
  | { id: string; tipo: "usuario"; texto: string }
  | { id: string; tipo: "assistente"; texto: string }
  | { id: string; tipo: "erro"; texto: string }
  | {
      id: string;
      tipo: "tool";
      nome: string;
      args: Record<string, unknown>;
      status: "rodando" | "ok" | "erro" | "cancelada";
      resultado?: string;
      dados?: Dados;
    }
  | { id: string; tipo: "confirmacao"; callId: string; resumo: string; estado: "aguardando" | "aprovada" | "cancelada" };

const ROTULOS: Record<string, [rodando: string, feito: string]> = {
  listar_eventos: ["Consultando a agenda", "Consultou a agenda"],
  buscar_evento: ["Abrindo o evento", "Abriu o evento"],
  verificar_disponibilidade: ["Verificando disponibilidade", "Verificou disponibilidade"],
  criar_evento: ["Criando evento", "Criou evento"],
  atualizar_evento: ["Atualizando evento", "Atualizou evento"],
  remover_evento: ["Removendo evento", "Removeu evento"],
  criar_eventos_recorrentes: ["Criando série", "Criou série"],
  criar_eventos_em_lote: ["Criando eventos", "Criou eventos"],
  remover_eventos_em_lote: ["Removendo eventos", "Removeu eventos"],
};

const SUGESTOES = [
  "O que tenho amanhã?",
  "Estou livre amanhã ao meio-dia?",
  "Marca reunião sexta 14h às 15h",
  "Cancela o almoço com cliente",
];

type EventoResumo = { titulo: string; inicio: string; fim: string };

function faixa(de: unknown, ate: unknown): string {
  if (typeof de !== "string" || typeof ate !== "string") return "";
  const a = new Date(de);
  const b = new Date(ate);
  const diaInteiro = a.getHours() === 0 && a.getMinutes() === 0 && b.getHours() === 0 && b.getMinutes() === 0;
  if (diaInteiro && b.getTime() - a.getTime() === 86_400_000) return dia(a);
  if (a.toDateString() === b.toDateString()) return intervalo(a, b);
  return `${dia(a)} → ${dia(b)}`;
}

function detalhe(item: Extract<Item, { tipo: "tool" }>): string {
  const { nome, args, dados, status } = item;
  if (status === "cancelada") return "cancelado por você";
  const ev = (dados?.evento as EventoResumo | undefined) ?? undefined;
  switch (nome) {
    case "listar_eventos": {
      const base = faixa(args.de, args.ate);
      return dados ? `${base} · ${String(dados.total)} evento(s)` : base;
    }
    case "verificar_disponibilidade": {
      const base = faixa(args.de, args.ate);
      if (!dados) return base;
      const n = (dados.conflitos as unknown[]).length;
      return `${base} · ${dados.livre ? "livre" : `${n} conflito(s)`}`;
    }
    case "criar_evento":
    case "atualizar_evento": {
      const e = ev ?? (args as Partial<EventoResumo>);
      const quando = e.inicio && e.fim ? ` · ${intervalo(e.inicio, e.fim)}` : "";
      const conflitos = (dados?.conflitos as unknown[] | undefined)?.length;
      return `${e.titulo ? `“${e.titulo}”` : ""}${quando}${conflitos ? ` · ⚠ ${conflitos} conflito(s)` : ""}`;
    }
    case "criar_eventos_recorrentes":
    case "criar_eventos_em_lote": {
      const regra =
        nome === "criar_eventos_recorrentes"
          ? `“${String(args.titulo)}” · ${(args.diasDaSemana as string[] | undefined)?.join("/") ?? ""} ${String(args.horaInicio ?? "")}–${String(args.horaFim ?? "")}`
          : `${(args.eventos as unknown[] | undefined)?.length ?? 0} evento(s)`;
      if (!dados) return regra;
      const conflitos = (dados.conflitos as unknown[] | undefined)?.length;
      return `${regra} · ${String(dados.total)} criado(s)${conflitos ? ` · ⚠ ${conflitos} conflito(s)` : ""}`;
    }
    case "remover_eventos_em_lote":
      return dados ? `${String(dados.removidos)} removido(s)` : `${(args.ids as unknown[] | undefined)?.length ?? 0} evento(s)`;
    case "remover_evento":
    case "buscar_evento":
      return ev ? `“${ev.titulo}” · ${intervalo(ev.inicio, ev.fim)}` : "";
    default:
      return "";
  }
}

interface Props {
  prefill?: { texto: string; n: number };
  onMutacao(nome: string, dados: Dados): void;
}

let seq = 0;
const novoId = () => `i${++seq}`;

export function Chat({ prefill, onMutacao }: Props) {
  const [itens, setItens] = useState<Item[]>([]);
  const [texto, setTexto] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const conversaId = useRef<string | undefined>(undefined);
  const fimRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fimRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [itens, ocupado]);

  useEffect(() => {
    if (!prefill) return;
    setTexto(prefill.texto);
    const el = inputRef.current;
    if (el) {
      el.focus();
      requestAnimationFrame(() => el.setSelectionRange(prefill.texto.length, prefill.texto.length));
    }
  }, [prefill]);

  function aoEvento(e: EventoChat) {
    switch (e.tipo) {
      case "inicio":
        conversaId.current = e.conversaId;
        break;
      case "tool_call":
        setItens((xs) => [...xs, { id: e.callId, tipo: "tool", nome: e.nome, args: e.args, status: "rodando" }]);
        break;
      case "tool_result": {
        const status = e.cancelada ? "cancelada" : e.isError ? "erro" : "ok";
        setItens((xs) => {
          const existe = xs.some((x) => x.tipo === "tool" && x.id === e.callId);
          const atualizado = { resultado: e.texto, dados: e.dados, status } as const;
          return existe
            ? xs.map((x) => (x.tipo === "tool" && x.id === e.callId ? { ...x, ...atualizado } : x))
            : [...xs, { id: e.callId, tipo: "tool", nome: e.nome, args: {}, ...atualizado }];
        });
        if (e.mutou) onMutacao(e.nome, e.dados);
        break;
      }
      case "confirmacao":
        setItens((xs) => [
          ...xs,
          { id: novoId(), tipo: "confirmacao", callId: e.callId, resumo: e.resumo, estado: "aguardando" },
        ]);
        break;
      case "mensagem":
        setItens((xs) => [...xs, { id: novoId(), tipo: "assistente", texto: e.texto }]);
        break;
      case "erro":
        setItens((xs) => [...xs, { id: novoId(), tipo: "erro", texto: e.mensagem }]);
        break;
      case "fim":
        setOcupado(false);
        break;
    }
  }

  async function enviar(msg: string) {
    const t = msg.trim();
    if (!t || ocupado) return;
    setTexto("");
    setOcupado(true);
    // Mensagem nova cancela uma confirmação em aberto (o servidor faz o mesmo).
    setItens((xs) => [
      ...xs.map((x) => (x.tipo === "confirmacao" && x.estado === "aguardando" ? { ...x, estado: "cancelada" as const } : x)),
      { id: novoId(), tipo: "usuario", texto: t },
    ]);
    await enviarMensagem(conversaId.current, t, aoEvento);
  }

  async function confirmar(item: Extract<Item, { tipo: "confirmacao" }>, aprovado: boolean) {
    if (!conversaId.current || ocupado) return;
    setOcupado(true);
    setItens((xs) =>
      xs.map((x) => (x.id === item.id ? { ...item, estado: aprovado ? "aprovada" : "cancelada" } : x)),
    );
    await responderConfirmacao(conversaId.current, item.callId, aprovado, aoEvento);
  }

  function aoSubmeter(ev: FormEvent) {
    ev.preventDefault();
    void enviar(texto);
  }

  return (
    <section className="chat" aria-label="Assistente">
      <div className="chat-rolagem">
        {itens.length === 0 && (
          <div className="vazio">
            <h2>Peça em linguagem natural</h2>
            <p>O assistente consulta e altera a agenda pelas tools do servidor MCP. Você também pode arrastar no calendário para marcar um horário.</p>
            <div className="sugestoes">
              {SUGESTOES.map((s) => (
                <button key={s} type="button" onClick={() => void enviar(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {itens.map((item) => {
          switch (item.tipo) {
            case "usuario":
              return (
                <div key={item.id} className="msg usuario">
                  {item.texto}
                </div>
              );
            case "assistente":
              return (
                <div key={item.id} className="msg assistente">
                  <Texto>{item.texto}</Texto>
                </div>
              );
            case "erro":
              return (
                <div key={item.id} className="msg erro" role="alert">
                  {item.texto}
                </div>
              );
            case "tool": {
              const [rodando, feito] = ROTULOS[item.nome] ?? [item.nome, item.nome];
              return (
                <details key={item.id} className={`tool ${item.status}`}>
                  <summary>
                    <span className="tool-icone" aria-hidden="true" />
                    <span className="tool-nome">{item.status === "rodando" ? `${rodando}…` : feito}</span>
                    <span className="tool-detalhe">{detalhe(item)}</span>
                  </summary>
                  <div className="tool-corpo">
                    <div className="rotulo">
                      tool <code>{item.nome}</code>
                    </div>
                    <pre>{JSON.stringify(item.args, null, 2)}</pre>
                    {item.resultado && (
                      <>
                        <div className="rotulo">resultado{item.status === "erro" ? " (isError)" : ""}</div>
                        <pre>{item.resultado}</pre>
                      </>
                    )}
                  </div>
                </details>
              );
            }
            case "confirmacao":
              return (
                <div key={item.id} className={`confirmacao ${item.estado}`}>
                  <div className="confirmacao-titulo">Confirmar ação destrutiva</div>
                  <div className="confirmacao-resumo">{item.resumo}</div>
                  {item.estado === "aguardando" ? (
                    <div className="confirmacao-botoes">
                      <button type="button" className="perigo" onClick={() => void confirmar(item, true)} disabled={ocupado}>
                        Remover
                      </button>
                      <button type="button" onClick={() => void confirmar(item, false)} disabled={ocupado}>
                        Manter
                      </button>
                    </div>
                  ) : (
                    <div className="confirmacao-estado">{item.estado === "aprovada" ? "Você confirmou." : "Você cancelou."}</div>
                  )}
                </div>
              );
          }
        })}

        {ocupado && (
          <div className="pensando" aria-live="polite">
            <span />
            <span />
            <span />
          </div>
        )}
        <div ref={fimRef} />
      </div>

      <form className="compor" onSubmit={aoSubmeter}>
        <textarea
          id="mensagem"
          ref={inputRef}
          value={texto}
          rows={2}
          placeholder="Ex: marca dentista quinta às 10h"
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void enviar(texto);
            }
          }}
        />
        <button type="submit" disabled={ocupado || !texto.trim()}>
          Enviar
        </button>
      </form>
      <p className="dica">
        Enter envia · Shift+Enter quebra linha · hoje é {dia(new Date())}, {hora(new Date())}
      </p>
    </section>
  );
}
