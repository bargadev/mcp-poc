import type { Evento } from "@agenda/api/schemas";
import type { EventSourceFuncArg, EventInput } from "@fullcalendar/core";
import ptBr from "@fullcalendar/core/locales/pt-br";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import { forwardRef, useImperativeHandle, useRef, useState } from "react";

export interface CalendarioHandle {
  recarregar(): void;
  irPara(data: string): void;
}

interface Props {
  destaque?: string;
  onSelecionarIntervalo(inicio: Date, fim: Date): void;
  onClicarEvento(ev: { titulo: string; inicio: Date; fim: Date }): void;
}

export const Calendario = forwardRef<CalendarioHandle, Props>(function Calendario(
  { destaque, onSelecionarIntervalo, onClicarEvento },
  ref,
) {
  const fc = useRef<FullCalendar>(null);
  const [erro, setErro] = useState<string>();

  useImperativeHandle(ref, () => ({
    recarregar: () => fc.current?.getApi().refetchEvents(),
    irPara: (data) => fc.current?.getApi().gotoDate(data),
  }));

  async function buscar(info: EventSourceFuncArg): Promise<EventInput[]> {
    const q = new URLSearchParams({ de: info.startStr, ate: info.endStr });
    try {
      const res = await fetch(`/api/eventos?${q}`);
      if (!res.ok) throw new Error(String(res.status));
      setErro(undefined);
      const eventos = (await res.json()) as Evento[];
      return eventos.map((e) => ({
        id: e.id,
        title: e.titulo,
        start: e.inicio,
        end: e.fim,
        extendedProps: { descricao: e.descricao },
      }));
    } catch {
      setErro("Não consegui ler a agenda-api. Ela está rodando? (pnpm dev:api)");
      return [];
    }
  }

  return (
    <section className="calendario" aria-label="Calendário">
      {erro && <div className="aviso">{erro}</div>}
      <FullCalendar
        ref={fc}
        plugins={[timeGridPlugin, dayGridPlugin, interactionPlugin]}
        locale={ptBr}
        initialView="timeGridWeek"
        headerToolbar={{ left: "prev,next today", center: "title", right: "timeGridDay,timeGridWeek,dayGridMonth" }}
        height="100%"
        allDaySlot={false}
        nowIndicator
        slotMinTime="07:00:00"
        slotMaxTime="22:00:00"
        scrollTime="08:00:00"
        slotDuration="00:30:00"
        expandRows
        selectable
        selectMirror
        unselectAuto
        events={buscar}
        eventClassNames={(arg) => (arg.event.id === destaque ? ["destaque"] : [])}
        eventTimeFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
        select={(info) => {
          onSelecionarIntervalo(info.start, info.end);
          info.view.calendar.unselect();
        }}
        eventClick={(info) => {
          const { title, start, end } = info.event;
          if (start && end) onClicarEvento({ titulo: title, inicio: start, fim: end });
        }}
      />
    </section>
  );
});
