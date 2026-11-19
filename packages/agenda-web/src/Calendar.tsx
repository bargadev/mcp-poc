import type { Event } from "@agenda/api/schemas";
import type { EventInput, EventSourceFuncArg } from "@fullcalendar/core";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import { forwardRef, useImperativeHandle, useRef, useState } from "react";

export interface CalendarHandle {
  reload(): void;
  goTo(date: string): void;
}

interface Props {
  highlight?: string;
  onSelectRange(start: Date, end: Date): void;
  onEventClick(ev: { title: string; start: Date; end: Date }): void;
}

export const Calendar = forwardRef<CalendarHandle, Props>(function Calendar(
  { highlight, onSelectRange, onEventClick },
  ref,
) {
  const fc = useRef<FullCalendar>(null);
  const [error, setError] = useState<string>();

  useImperativeHandle(ref, () => ({
    reload: () => fc.current?.getApi().refetchEvents(),
    goTo: (date) => fc.current?.getApi().gotoDate(date),
  }));

  async function fetchEvents(info: EventSourceFuncArg): Promise<EventInput[]> {
    const q = new URLSearchParams({ from: info.startStr, to: info.endStr });
    try {
      const res = await fetch(`/api/events?${q}`);
      if (!res.ok) throw new Error(String(res.status));
      setError(undefined);
      const events = (await res.json()) as Event[];
      return events.map((e) => ({
        id: e.id,
        title: e.title,
        start: e.start,
        end: e.end,
        extendedProps: { description: e.description },
      }));
    } catch {
      setError("Could not read agenda-api. Is it running? (pnpm dev:api)");
      return [];
    }
  }

  return (
    <section className="calendar" aria-label="Calendar">
      {error && <div className="notice">{error}</div>}
      <FullCalendar
        ref={fc}
        plugins={[timeGridPlugin, dayGridPlugin, interactionPlugin]}
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
        events={fetchEvents}
        eventClassNames={(arg) => (arg.event.id === highlight ? ["highlight-event"] : [])}
        eventTimeFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
        select={(info) => {
          onSelectRange(info.start, info.end);
          info.view.calendar.unselect();
        }}
        eventClick={(info) => {
          const { title, start, end } = info.event;
          if (start && end) onEventClick({ title, start, end });
        }}
      />
    </section>
  );
});
