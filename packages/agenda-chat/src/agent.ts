import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  FunctionTool,
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseFunctionToolCall,
  ResponseInputItem,
} from "openai/resources/responses/responses";
import type { ChatEvent, UserContext } from "./events.js";

/** Only the slice of the OpenAI SDK the agent uses (makes mocking in tests easy). */
export type CreateResponse = (params: ResponseCreateParamsNonStreaming) => Promise<Pick<Response, "output" | "output_text">>;

export type McpClient = Pick<Client, "callTool" | "listTools" | "getInstructions">;

export type Emit = (event: ChatEvent) => void;

interface Tool {
  definition: FunctionTool;
  readOnly: boolean;
  destructive: boolean;
}

export interface Conversation {
  id: string;
  items: ResponseInputItem[];
  /** Destructive call waiting for the user to confirm or cancel. */
  pending?: ResponseFunctionToolCall;
}

export interface AgentOptions {
  createResponse: CreateResponse;
  mcp: McpClient;
  model: string;
  effort?: "minimal" | "low" | "medium" | "high";
  maxSteps?: number;
}

const MSG_CANCELLED =
  'The user clicked Cancel on the confirmation: the action was NOT executed and nothing changed in the agenda. Say so in one short sentence (e.g. "Ok, I kept the event.") and do not try again.';

/** Converts the MCP tools into OpenAI function tools, keeping the annotations. */
export async function loadTools(mcp: McpClient): Promise<Map<string, Tool>> {
  const { tools } = await mcp.listTools();
  return new Map(
    tools.map((t) => {
      const { $schema: _, ...parameters } = t.inputSchema as Record<string, unknown>;
      return [
        t.name,
        {
          definition: {
            type: "function",
            name: t.name,
            description: t.description ?? t.title ?? t.name,
            parameters,
            strict: false,
          },
          readOnly: t.annotations?.readOnlyHint === true,
          // MCP spec: destructiveHint defaults to true when the tool is not read-only.
          destructive: t.annotations?.readOnlyHint !== true && t.annotations?.destructiveHint !== false,
        } satisfies Tool,
      ];
    }),
  );
}

export function buildInstructions(ctx: UserContext, mcpInstructions?: string): string {
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: ctx.timeZone }).format(
    new Date(ctx.now),
  );
  return `You are the assistant for the user's personal agenda and you act through the available tools.

Current context: it is now ${ctx.now} (${weekday}), time zone ${ctx.timeZone}. Use this to resolve relative dates ("tomorrow", "Friday", "next week") and use this offset in the dates you send to the tools.

Rules:
- Reply in the same language the user writes in, short and to the point. Use natural, compact times and dates (e.g. "2–3pm", "Fri, Nov 21").
- Do not show ids or JSON to the user; use ids only to chain tools.
- To update or delete, find the event with list_events. If more than one event could match, ask which one.
- Before creating or rescheduling, check availability and warn about conflicts.
- Several events at once: use create_recurring_events (weekly repetition), create_events_batch or delete_events_batch, in a single call. Never call create_event or delete_event repeatedly.
- To delete, just call delete_event: the interface asks the user for confirmation before running it.
- If essential information is missing (e.g. the time), ask instead of making it up.
${mcpInstructions ? `\nAgenda server instructions:\n${mcpInstructions}` : ""}`;
}

function resultText(result: Awaited<ReturnType<McpClient["callTool"]>>): string {
  const content = (result.content ?? []) as { type: string; text?: string }[];
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

function parseArgs(call: ResponseFunctionToolCall): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(call.arguments || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const fmtTime = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(
    new Date(iso),
  );
const fmtDay = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { weekday: "short", day: "2-digit", month: "2-digit", timeZone }).format(
    new Date(iso),
  );

type EventLike = { title: string; start: string; end: string };

export function createAgent(options: AgentOptions) {
  const { createResponse, mcp, model, effort, maxSteps = 20 } = options;
  let tools: Map<string, Tool> | undefined;

  async function getTools() {
    tools ??= await loadTools(mcp);
    return tools;
  }

  async function execute(conv: Conversation, call: ResponseFunctionToolCall, emit: Emit) {
    const tool = (await getTools()).get(call.name);
    const args = parseArgs(call);
    emit({ type: "tool_call", callId: call.call_id, name: call.name, args: args ?? {} });

    let text: string;
    let isError: boolean;
    let data: Record<string, unknown> | undefined;
    if (!tool) {
      [text, isError] = [`Unknown tool: ${call.name}.`, true];
    } else if (!args) {
      [text, isError] = ["The arguments are not a valid JSON object. Fix them and try again.", true];
    } else {
      try {
        const r = await mcp.callTool({ name: call.name, arguments: args });
        text = resultText(r);
        isError = r.isError === true;
        data = r.structuredContent as Record<string, unknown> | undefined;
      } catch (e) {
        text = `Failed to call the agenda MCP server: ${e instanceof Error ? e.message : String(e)}`;
        isError = true;
      }
    }

    conv.items.push({
      type: "function_call_output",
      call_id: call.call_id,
      output: isError ? `ERROR: ${text}` : text,
    });
    emit({
      type: "tool_result",
      callId: call.call_id,
      name: call.name,
      isError,
      text,
      data,
      mutated: !isError && tool?.readOnly === false,
    });
  }

  async function fetchEvent(id: string): Promise<EventLike | undefined> {
    try {
      const r = await mcp.callTool({ name: "get_event", arguments: { id } });
      if (r.isError) return undefined;
      return (r.structuredContent as { event?: EventLike } | undefined)?.event;
    } catch {
      return undefined;
    }
  }

  /** Describes the destructive action with real event data (read-only lookup). */
  async function summarizeAction(call: ResponseFunctionToolCall, ctx: UserContext): Promise<string> {
    const args = parseArgs(call) ?? {};
    if (call.name === "delete_event" && typeof args.id === "string") {
      const ev = await fetchEvent(args.id);
      if (ev) {
        const tz = ctx.timeZone;
        return `Delete “${ev.title}” (${fmtDay(ev.start, tz)}, ${fmtTime(ev.start, tz)}–${fmtTime(ev.end, tz)})`;
      }
    }
    if (call.name === "delete_events_batch" && Array.isArray(args.ids)) {
      return summarizeBatch(args.ids.filter((x): x is string => typeof x === "string"), ctx);
    }
    return `Run ${call.name}`;
  }

  /** "Delete 11 event(s): 11× “Jiu-jitsu” (Mon, 11/30 → Wed, 12/23)" */
  async function summarizeBatch(ids: string[], ctx: UserContext): Promise<string> {
    const events: EventLike[] = [];
    for (let i = 0; i < ids.length; i += 20) {
      const chunk = await Promise.all(ids.slice(i, i + 20).map(fetchEvent));
      events.push(...chunk.filter((e): e is EventLike => !!e));
    }
    const base = `Delete ${ids.length} event(s)`;
    if (!events.length) return base;
    const counts = new Map<string, number>();
    for (const e of events) counts.set(e.title, (counts.get(e.title) ?? 0) + 1);
    const titles = [...counts]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([t, n]) => `${n}× “${t}”`)
      .join(", ");
    const tz = ctx.timeZone;
    const starts = events.map((e) => e.start).sort((a, b) => Date.parse(a) - Date.parse(b));
    const period = starts.length > 1 ? `${fmtDay(starts[0]!, tz)} → ${fmtDay(starts.at(-1)!, tz)}` : fmtDay(starts[0]!, tz);
    const notFound = ids.length - events.length;
    return `${base}: ${titles}${counts.size > 4 ? ", …" : ""} (${period})${notFound ? ` · ${notFound} id(s) not found` : ""}`;
  }

  /** Runs the loop until the model answers in text or asks for an action that needs confirmation. */
  async function loop(conv: Conversation, ctx: UserContext, emit: Emit) {
    const toolMap = await getTools();
    const instructions = buildInstructions(ctx, mcp.getInstructions());

    for (let step = 0; step < maxSteps; step++) {
      const response = await createResponse({
        model,
        instructions,
        input: conv.items,
        tools: [...toolMap.values()].map((t) => t.definition),
        parallel_tool_calls: false,
        ...(effort ? { reasoning: { effort } } : {}),
      });
      conv.items.push(...(response.output as ResponseInputItem[]));

      const calls = response.output.filter((i): i is ResponseFunctionToolCall => i.type === "function_call");
      if (calls.length === 0) {
        emit({ type: "message", text: response.output_text || "(no response)" });
        return;
      }

      for (const call of calls) {
        if (toolMap.get(call.name)?.destructive) {
          conv.pending = call;
          emit({
            type: "confirmation",
            callId: call.call_id,
            name: call.name,
            args: parseArgs(call) ?? {},
            summary: await summarizeAction(call, ctx),
          });
          return;
        }
        await execute(conv, call, emit);
      }
    }
    emit({
      type: "error",
      message: `Stopped after ${maxSteps} steps without finishing. What was done is saved; say "continue" and I will go on.`,
    });
  }

  function cancelPending(conv: Conversation, emit: Emit) {
    const call = conv.pending;
    if (!call) return;
    conv.pending = undefined;
    conv.items.push({ type: "function_call_output", call_id: call.call_id, output: MSG_CANCELLED });
    emit({
      type: "tool_result",
      callId: call.call_id,
      name: call.name,
      isError: false,
      text: "Cancelled by the user.",
      mutated: false,
      cancelled: true,
    });
  }

  return {
    async sendMessage(conv: Conversation, text: string, ctx: UserContext, emit: Emit) {
      // A new message while a confirmation is pending = the user gave up on that action.
      cancelPending(conv, emit);
      conv.items.push({ role: "user", content: text });
      await loop(conv, ctx, emit);
    },

    async confirm(conv: Conversation, callId: string, approved: boolean, ctx: UserContext, emit: Emit) {
      const call = conv.pending;
      if (!call || call.call_id !== callId) {
        emit({ type: "error", message: "There is no pending action with that id (it may already be resolved)." });
        return;
      }
      if (approved) {
        conv.pending = undefined;
        await execute(conv, call, emit);
      } else {
        cancelPending(conv, emit);
      }
      await loop(conv, ctx, emit);
    },
  };
}

export type Agent = ReturnType<typeof createAgent>;
