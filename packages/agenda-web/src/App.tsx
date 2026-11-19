import { useCallback, useEffect, useRef, useState } from "react";
import { Calendar, type CalendarHandle } from "./Calendar.tsx";
import { Chat } from "./Chat.tsx";
import { day, range, time } from "./dates.ts";

type Status = { state: "loading" } | { state: "ok"; model?: string } | { state: "offline" };

export function App() {
  const cal = useRef<CalendarHandle>(null);
  const [highlight, setHighlight] = useState<string>();
  const [prefill, setPrefill] = useState<{ text: string; n: number }>();
  const [status, setStatus] = useState<Status>({ state: "loading" });
  const clearHighlight = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    let alive = true;
    const check = () =>
      fetch("/chat/health")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
        .then((j: { model?: string }) => alive && setStatus({ state: "ok", model: j.model }))
        .catch(() => alive && setStatus({ state: "offline" }));
    void check();
    const t = setInterval(check, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const onMutation = useCallback((name: string, data: Record<string, unknown> | undefined) => {
    const ev = data?.event as { id: string; start: string } | undefined;
    if (ev && name !== "delete_event") {
      setHighlight(ev.id);
      cal.current?.goTo(ev.start);
      clearTimeout(clearHighlight.current);
      clearHighlight.current = setTimeout(() => setHighlight(undefined), 6000);
    }
    cal.current?.reload();
  }, []);

  const fill = (text: string) => setPrefill((p) => ({ text, n: (p?.n ?? 0) + 1 }));

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon" aria-hidden="true" />
          <h1>Agenda</h1>
        </div>
        <div className={`status ${status.state}`}>
          <span className="dot" aria-hidden="true" />
          {status.state === "ok" && <>assistant via MCP · {status.model ?? "OpenAI"}</>}
          {status.state === "offline" && <>assistant offline — run pnpm dev:chat</>}
          {status.state === "loading" && <>connecting…</>}
        </div>
      </header>
      <main className="main-grid">
        <Calendar
          ref={cal}
          highlight={highlight}
          onSelectRange={(start, end) => fill(`Book an event on ${day(start)} from ${time(start)} to ${time(end)}: `)}
          onEventClick={(ev) => fill(`About “${ev.title}” (${range(ev.start, ev.end)}): `)}
        />
        <Chat prefill={prefill} onMutation={onMutation} />
      </main>
    </div>
  );
}
