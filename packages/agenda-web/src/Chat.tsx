import type { ChatEvent } from "@agenda/chat/events";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { answerConfirmation, sendMessage } from "./chatClient.ts";
import { day, range, time } from "./dates.ts";
import { RichText } from "./RichText.tsx";

type Data = Record<string, unknown> | undefined;

type Item =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string }
  | { id: string; kind: "error"; text: string }
  | {
      id: string;
      kind: "tool";
      name: string;
      args: Record<string, unknown>;
      status: "running" | "ok" | "error" | "cancelled";
      result?: string;
      data?: Data;
    }
  | { id: string; kind: "confirmation"; callId: string; summary: string; state: "waiting" | "approved" | "cancelled" };

const LABELS: Record<string, [running: string, done: string]> = {
  list_events: ["Checking the agenda", "Checked the agenda"],
  get_event: ["Opening the event", "Opened the event"],
  check_availability: ["Checking availability", "Checked availability"],
  create_event: ["Creating event", "Created event"],
  update_event: ["Updating event", "Updated event"],
  delete_event: ["Deleting event", "Deleted event"],
  create_recurring_events: ["Creating series", "Created series"],
  create_events_batch: ["Creating events", "Created events"],
  delete_events_batch: ["Deleting events", "Deleted events"],
};

const SUGGESTIONS = [
  "What do I have tomorrow?",
  "Am I free tomorrow at noon?",
  "Book a meeting Friday 2pm to 3pm",
  "Cancel the lunch with client",
];

type EventSummary = { title: string; start: string; end: string };

function span(from: unknown, to: unknown): string {
  if (typeof from !== "string" || typeof to !== "string") return "";
  const a = new Date(from);
  const b = new Date(to);
  const wholeDay = a.getHours() === 0 && a.getMinutes() === 0 && b.getHours() === 0 && b.getMinutes() === 0;
  if (wholeDay && b.getTime() - a.getTime() === 86_400_000) return day(a);
  if (a.toDateString() === b.toDateString()) return range(a, b);
  return `${day(a)} → ${day(b)}`;
}

function detail(item: Extract<Item, { kind: "tool" }>): string {
  const { name, args, data, status } = item;
  if (status === "cancelled") return "cancelled by you";
  const ev = data?.event as EventSummary | undefined;
  switch (name) {
    case "list_events": {
      const base = span(args.from, args.to);
      return data ? `${base} · ${String(data.total)} event(s)` : base;
    }
    case "check_availability": {
      const base = span(args.from, args.to);
      if (!data) return base;
      const n = (data.conflicts as unknown[]).length;
      return `${base} · ${data.free ? "free" : `${n} conflict(s)`}`;
    }
    case "create_event":
    case "update_event": {
      const e = ev ?? (args as Partial<EventSummary>);
      const when = e.start && e.end ? ` · ${range(e.start, e.end)}` : "";
      const conflicts = (data?.conflicts as unknown[] | undefined)?.length;
      return `${e.title ? `“${e.title}”` : ""}${when}${conflicts ? ` · ⚠ ${conflicts} conflict(s)` : ""}`;
    }
    case "create_recurring_events":
    case "create_events_batch": {
      const rule =
        name === "create_recurring_events"
          ? `“${String(args.title)}” · ${(args.weekdays as string[] | undefined)?.join("/") ?? ""} ${String(args.startTime ?? "")}–${String(args.endTime ?? "")}`
          : `${(args.events as unknown[] | undefined)?.length ?? 0} event(s)`;
      if (!data) return rule;
      const conflicts = (data.conflicts as unknown[] | undefined)?.length;
      return `${rule} · ${String(data.total)} created${conflicts ? ` · ⚠ ${conflicts} conflict(s)` : ""}`;
    }
    case "delete_events_batch":
      return data ? `${String(data.deleted)} deleted` : `${(args.ids as unknown[] | undefined)?.length ?? 0} event(s)`;
    case "delete_event":
    case "get_event":
      return ev ? `“${ev.title}” · ${range(ev.start, ev.end)}` : "";
    default:
      return "";
  }
}

interface Props {
  prefill?: { text: string; n: number };
  onMutation(name: string, data: Data): void;
}

let seq = 0;
const newId = () => `i${++seq}`;

export function Chat({ prefill, onMutation }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const conversationId = useRef<string | undefined>(undefined);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items, busy]);

  useEffect(() => {
    if (!prefill) return;
    setText(prefill.text);
    const el = inputRef.current;
    if (el) {
      el.focus();
      requestAnimationFrame(() => el.setSelectionRange(prefill.text.length, prefill.text.length));
    }
  }, [prefill]);

  function onEvent(e: ChatEvent) {
    switch (e.type) {
      case "start":
        conversationId.current = e.conversationId;
        break;
      case "tool_call":
        setItems((xs) => [...xs, { id: e.callId, kind: "tool", name: e.name, args: e.args, status: "running" }]);
        break;
      case "tool_result": {
        const status = e.cancelled ? "cancelled" : e.isError ? "error" : "ok";
        setItems((xs) => {
          const exists = xs.some((x) => x.kind === "tool" && x.id === e.callId);
          const patch = { result: e.text, data: e.data, status } as const;
          return exists
            ? xs.map((x) => (x.kind === "tool" && x.id === e.callId ? { ...x, ...patch } : x))
            : [...xs, { id: e.callId, kind: "tool", name: e.name, args: {}, ...patch }];
        });
        if (e.mutated) onMutation(e.name, e.data);
        break;
      }
      case "confirmation":
        setItems((xs) => [
          ...xs,
          { id: newId(), kind: "confirmation", callId: e.callId, summary: e.summary, state: "waiting" },
        ]);
        break;
      case "message":
        setItems((xs) => [...xs, { id: newId(), kind: "assistant", text: e.text }]);
        break;
      case "error":
        setItems((xs) => [...xs, { id: newId(), kind: "error", text: e.message }]);
        break;
      case "done":
        setBusy(false);
        break;
    }
  }

  async function send(msg: string) {
    const t = msg.trim();
    if (!t || busy) return;
    setText("");
    setBusy(true);
    // A new message cancels an open confirmation (the server does the same).
    setItems((xs) => [
      ...xs.map((x) => (x.kind === "confirmation" && x.state === "waiting" ? { ...x, state: "cancelled" as const } : x)),
      { id: newId(), kind: "user", text: t },
    ]);
    await sendMessage(conversationId.current, t, onEvent);
  }

  async function confirm(item: Extract<Item, { kind: "confirmation" }>, approved: boolean) {
    if (!conversationId.current || busy) return;
    setBusy(true);
    setItems((xs) => xs.map((x) => (x.id === item.id ? { ...item, state: approved ? "approved" : "cancelled" } : x)));
    await answerConfirmation(conversationId.current, item.callId, approved, onEvent);
  }

  function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    void send(text);
  }

  return (
    <section className="chat" aria-label="Assistant">
      <div className="chat-scroll">
        {items.length === 0 && (
          <div className="empty">
            <h2>Ask in natural language</h2>
            <p>
              The assistant reads and changes the agenda through the MCP server's tools. You can also drag on the
              calendar to pick a time slot.
            </p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => void send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {items.map((item) => {
          switch (item.kind) {
            case "user":
              return (
                <div key={item.id} className="msg user">
                  {item.text}
                </div>
              );
            case "assistant":
              return (
                <div key={item.id} className="msg assistant">
                  <RichText>{item.text}</RichText>
                </div>
              );
            case "error":
              return (
                <div key={item.id} className="msg error" role="alert">
                  {item.text}
                </div>
              );
            case "tool": {
              const [running, done] = LABELS[item.name] ?? [item.name, item.name];
              return (
                <details key={item.id} className={`tool ${item.status}`}>
                  <summary>
                    <span className="tool-icon" aria-hidden="true" />
                    <span className="tool-name">{item.status === "running" ? `${running}…` : done}</span>
                    <span className="tool-detail">{detail(item)}</span>
                  </summary>
                  <div className="tool-body">
                    <div className="label">
                      tool <code>{item.name}</code>
                    </div>
                    <pre>{JSON.stringify(item.args, null, 2)}</pre>
                    {item.result && (
                      <>
                        <div className="label">result{item.status === "error" ? " (isError)" : ""}</div>
                        <pre>{item.result}</pre>
                      </>
                    )}
                  </div>
                </details>
              );
            }
            case "confirmation":
              return (
                <div key={item.id} className={`confirmation ${item.state}`}>
                  <div className="confirmation-title">Confirm destructive action</div>
                  <div className="confirmation-summary">{item.summary}</div>
                  {item.state === "waiting" ? (
                    <div className="confirmation-buttons">
                      <button type="button" className="danger" onClick={() => void confirm(item, true)} disabled={busy}>
                        Delete
                      </button>
                      <button type="button" onClick={() => void confirm(item, false)} disabled={busy}>
                        Keep
                      </button>
                    </div>
                  ) : (
                    <div className="confirmation-state">{item.state === "approved" ? "You confirmed." : "You cancelled."}</div>
                  )}
                </div>
              );
          }
        })}

        {busy && (
          <div className="thinking" aria-live="polite">
            <span />
            <span />
            <span />
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form className="composer" onSubmit={onSubmit}>
        <textarea
          id="message"
          ref={inputRef}
          value={text}
          rows={2}
          placeholder="e.g. book the dentist Thursday at 10am"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(text);
            }
          }}
        />
        <button type="submit" disabled={busy || !text.trim()}>
          Send
        </button>
      </form>
      <p className="hint">
        Enter sends · Shift+Enter adds a line · today is {day(new Date())}, {time(new Date())}
      </p>
    </section>
  );
}
