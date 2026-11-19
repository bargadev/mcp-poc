/** Events sent to the browser over SSE. Types shared with agenda-web. */
export type ChatEvent =
  | { type: "start"; conversationId: string }
  | { type: "tool_call"; callId: string; name: string; args: Record<string, unknown> }
  | {
      type: "tool_result";
      callId: string;
      name: string;
      isError: boolean;
      text: string;
      data?: Record<string, unknown>;
      /** true when the tool changed the agenda (the calendar should reload). */
      mutated: boolean;
      cancelled?: boolean;
    }
  | {
      type: "confirmation";
      callId: string;
      name: string;
      args: Record<string, unknown>;
      /** Human-readable description of what will happen, e.g. "Delete “Team daily” (Fri, 11/20, 09:30–09:45)". */
      summary: string;
    }
  | { type: "message"; text: string }
  | { type: "error"; message: string }
  | { type: "done" };

/** Browser date/time context, so the model can resolve "tomorrow", "Friday", etc. */
export interface UserContext {
  /** Now, in ISO 8601 with offset, e.g. 2026-11-19T10:30:00-03:00 */
  now: string;
  /** IANA time zone, e.g. America/Sao_Paulo */
  timeZone: string;
}
