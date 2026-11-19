import { buildApp } from "@agenda/api/app";
import { openDb, type Db } from "@agenda/api/db";
import { createApiClient } from "@agenda/mcp/api-client";
import { createServer } from "@agenda/mcp/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  ResponseCreateParamsNonStreaming,
  ResponseInputItem,
  ResponseOutputItem,
} from "openai/resources/responses/responses";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgent, loadTools, type Conversation, type CreateResponse } from "../src/agent.js";
import { buildChatApp } from "../src/app.js";
import type { ChatEvent, UserContext } from "../src/events.js";

// ---------------------------------------------------------------------------
// Infra: real in-memory API (via app.inject) ← real in-memory MCP ← agent
// ---------------------------------------------------------------------------

let db: Db;
let api: ReturnType<typeof buildApp>;
let mcp: Client;
let closeMcp: () => Promise<void>;

const fetchIntoApi: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const r = await api.inject({
    method: (init?.method ?? "GET") as "GET",
    url: url.pathname + url.search,
    payload: init?.body as string | undefined,
    headers: init?.headers as Record<string, string> | undefined,
  });
  return new Response(r.statusCode === 204 ? null : r.body, {
    status: r.statusCode,
    headers: { "content-type": String(r.headers["content-type"] ?? "application/json") },
  });
};

beforeEach(async () => {
  db = openDb(":memory:");
  api = buildApp({ db });
  const server = createServer({ api: createApiClient({ baseUrl: "http://agenda.test", fetch: fetchIntoApi }) });
  mcp = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), mcp.connect(a)]);
  closeMcp = async () => {
    await mcp.close();
    await server.close();
  };
});

afterEach(async () => {
  await closeMcp();
  await api.close();
  db.close();
});

async function createInApi(title: string, start: string, end: string) {
  const r = await api.inject({ method: "POST", url: "/events", payload: { title, start, end } });
  return r.json() as { id: string; title: string };
}

async function titlesInApi() {
  return ((await api.inject({ method: "GET", url: "/events" })).json() as { title: string }[]).map((e) => e.title);
}

// ---------------------------------------------------------------------------
// Fake model: a script of responses, recording every request
// ---------------------------------------------------------------------------

type Step = (params: ResponseCreateParamsNonStreaming) => { output: ResponseOutputItem[]; output_text: string };

let seq = 0;
const callTool = (name: string, args: Record<string, unknown>): Step => () => ({
  output: [
    { type: "function_call", id: `fc_${++seq}`, call_id: `call_${seq}`, name, arguments: JSON.stringify(args), status: "completed" },
  ],
  output_text: "",
});
const reply = (text: string): Step => () => ({
  output: [
    {
      type: "message",
      id: `msg_${++seq}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    } as ResponseOutputItem,
  ],
  output_text: text,
});

function fakeModel(...steps: Step[]) {
  const requests: ResponseCreateParamsNonStreaming[] = [];
  const createResponse: CreateResponse = async (params) => {
    requests.push(structuredClone(params));
    const step = steps.shift();
    if (!step) throw new Error("fake model has no more steps");
    return step(params);
  };
  return { createResponse, requests };
}

const ctx: UserContext = { now: "2026-11-19T10:00:00-03:00", timeZone: "America/Sao_Paulo" };

function newConversation(): Conversation {
  return { id: "c1", items: [] };
}

function collector() {
  const events: ChatEvent[] = [];
  return { events, emit: (e: ChatEvent) => events.push(e), types: () => events.map((e) => e.type) };
}

const outputs = (items: ResponseInputItem[]) =>
  items.filter((i): i is ResponseInputItem.FunctionCallOutput => i.type === "function_call_output");

// ---------------------------------------------------------------------------

describe("loadTools", () => {
  it("converts the MCP tools and honors the annotations", async () => {
    const t = await loadTools(mcp);
    expect([...t.keys()].sort()).toEqual([
      "check_availability",
      "create_event",
      "create_events_batch",
      "create_recurring_events",
      "delete_event",
      "delete_events_batch",
      "get_event",
      "list_events",
      "update_event",
    ]);
    expect(t.get("delete_event")).toMatchObject({ destructive: true, readOnly: false });
    expect(t.get("delete_events_batch")).toMatchObject({ destructive: true });
    expect(t.get("create_recurring_events")).toMatchObject({ destructive: false, readOnly: false });
    expect(t.get("create_event")).toMatchObject({ destructive: false, readOnly: false });
    expect(t.get("list_events")).toMatchObject({ destructive: false, readOnly: true });
    const def = t.get("create_event")!.definition;
    expect(def).toMatchObject({ type: "function", name: "create_event", strict: false });
    expect(def.parameters).not.toHaveProperty("$schema");
    expect(def.description).toContain("ISO 8601");
  });
});

describe("agent loop", () => {
  it("read: calls the tool, returns the result to the model and emits the final answer", async () => {
    await createInApi("Daily", "2026-11-20T09:30:00-03:00", "2026-11-20T09:45:00-03:00");
    const m = fakeModel(
      callTool("list_events", { from: "2026-11-20T00:00:00-03:00", to: "2026-11-21T00:00:00-03:00" }),
      reply("Tomorrow you have the Daily at 9:30."),
    );
    const agent = createAgent({ createResponse: m.createResponse, mcp, model: "test-model" });
    const conv = newConversation();
    const c = collector();

    await agent.sendMessage(conv, "what do I have tomorrow?", ctx, c.emit);

    expect(c.types()).toEqual(["tool_call", "tool_result", "message"]);
    expect(c.events[1]).toMatchObject({ name: "list_events", isError: false, mutated: false });
    expect(c.events[2]).toEqual({ type: "message", text: "Tomorrow you have the Daily at 9:30." });

    // 1st request: date context in the system prompt, tools, one call at a time
    expect(m.requests[0]).toMatchObject({ model: "test-model", parallel_tool_calls: false });
    expect(m.requests[0]!.instructions).toContain("2026-11-19T10:00:00-03:00");
    expect(m.requests[0]!.instructions).toContain("Thursday");
    expect(m.requests[0]!.tools).toHaveLength(9);
    // 2nd request: the tool result (with id) goes back to the model
    const [out] = outputs(m.requests[1]!.input as ResponseInputItem[]);
    expect(out!.output).toContain("Daily");
    expect(out!.output).toMatch(/id [0-9a-f-]{36}/);
  });

  it("write: creates the event in the API and flags mutated=true", async () => {
    const m = fakeModel(
      callTool("check_availability", { from: "2026-11-21T14:00:00-03:00", to: "2026-11-21T15:00:00-03:00" }),
      callTool("create_event", {
        title: "Meeting",
        start: "2026-11-21T14:00:00-03:00",
        end: "2026-11-21T15:00:00-03:00",
      }),
      reply("Booked the meeting Friday 2–3pm."),
    );
    const agent = createAgent({ createResponse: m.createResponse, mcp, model: "x" });
    const c = collector();

    await agent.sendMessage(newConversation(), "book a meeting Friday 2pm to 3pm", ctx, c.emit);

    const results = c.events.filter((e) => e.type === "tool_result");
    expect(results.map((r) => [r.name, r.mutated])).toEqual([
      ["check_availability", false],
      ["create_event", true],
    ]);
    expect((results[1]!.data as { event: { id: string } }).event.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await titlesInApi()).toEqual(["Meeting"]);
  });

  it("a tool error goes back to the model as ERROR and the loop continues", async () => {
    const m = fakeModel(
      callTool("create_event", { title: "X", start: "2026-11-21T15:00:00-03:00", end: "2026-11-21T14:00:00-03:00" }),
      reply("The end must be after the start."),
    );
    const agent = createAgent({ createResponse: m.createResponse, mcp, model: "x" });
    const c = collector();
    await agent.sendMessage(newConversation(), "book X", ctx, c.emit);

    expect(c.events[1]).toMatchObject({ type: "tool_result", isError: true, mutated: false });
    expect(outputs(m.requests[1]!.input as ResponseInputItem[])[0]!.output).toBe(
      "ERROR: Invalid data — end: end must be after start",
    );
    expect(await titlesInApi()).toEqual([]);
  });

  it("arguments that are not JSON become an error for the model to fix", async () => {
    const m = fakeModel(
      () => ({
        output: [{ type: "function_call", call_id: "call_x", name: "list_events", arguments: "{from:" }],
        output_text: "",
      }),
      reply("ok"),
    );
    const agent = createAgent({ createResponse: m.createResponse, mcp, model: "x" });
    const c = collector();
    await agent.sendMessage(newConversation(), "?", ctx, c.emit);
    expect(c.events[1]).toMatchObject({ type: "tool_result", isError: true });
    expect(outputs(m.requests[1]!.input as ResponseInputItem[])[0]!.output).toContain("JSON");
  });

  it("stops after maxSteps if the model never answers in text", async () => {
    const steps = Array.from({ length: 3 }, () =>
      callTool("list_events", { from: "2026-11-20T00:00:00-03:00", to: "2026-11-21T00:00:00-03:00" }),
    );
    const agent = createAgent({ createResponse: fakeModel(...steps).createResponse, mcp, model: "x", maxSteps: 3 });
    const c = collector();
    await agent.sendMessage(newConversation(), "?", ctx, c.emit);
    expect(c.events.at(-1)).toMatchObject({ type: "error" });
  });
});

describe("destructive action confirmation (destructiveHint)", () => {
  async function requestDeletion() {
    const ev = await createInApi("Lunch with client", "2026-11-20T12:00:00-03:00", "2026-11-20T13:30:00-03:00");
    const m = fakeModel(callTool("delete_event", { id: ev.id }));
    const conv = newConversation();
    const c = collector();
    await createAgent({ createResponse: m.createResponse, mcp, model: "x" }).sendMessage(
      conv,
      "cancel the lunch",
      ctx,
      c.emit,
    );
    return { conv, c };
  }

  it("pauses before running and describes the real event", async () => {
    const { conv, c } = await requestDeletion();
    expect(c.types()).toEqual(["confirmation"]);
    const conf = c.events[0] as Extract<ChatEvent, { type: "confirmation" }>;
    expect(conf.summary).toBe("Delete “Lunch with client” (Fri, 11/20, 12:00–13:30)");
    expect(conv.pending?.call_id).toBe(conf.callId);
    expect(await titlesInApi()).toEqual(["Lunch with client"]);
  });

  it("approved: runs it, reports the change and continues the loop", async () => {
    const { conv } = await requestDeletion();
    const callId = conv.pending!.call_id;
    const m2 = fakeModel(reply("Done, I deleted the lunch."));
    const c2 = collector();

    await createAgent({ createResponse: m2.createResponse, mcp, model: "x" }).confirm(conv, callId, true, ctx, c2.emit);

    expect(c2.types()).toEqual(["tool_call", "tool_result", "message"]);
    expect(c2.events[1]).toMatchObject({ name: "delete_event", mutated: true, isError: false });
    expect(await titlesInApi()).toEqual([]);
    expect(conv.pending).toBeUndefined();
  });

  it("cancelled: does not run it and the model is told about the cancellation", async () => {
    const { conv } = await requestDeletion();
    const callId = conv.pending!.call_id;
    const m2 = fakeModel(reply("Ok, I kept the event."));
    const c2 = collector();
    await createAgent({ createResponse: m2.createResponse, mcp, model: "x" }).confirm(conv, callId, false, ctx, c2.emit);

    expect(c2.events[0]).toMatchObject({ type: "tool_result", cancelled: true, mutated: false });
    expect(outputs(m2.requests[0]!.input as ResponseInputItem[]).at(-1)!.output).toContain("was NOT executed");
    expect(await titlesInApi()).toEqual(["Lunch with client"]);
  });

  it("a new message while a confirmation is pending cancels the action", async () => {
    const { conv } = await requestDeletion();
    const m2 = fakeModel(reply("Sure."));
    const c2 = collector();
    await createAgent({ createResponse: m2.createResponse, mcp, model: "x" }).sendMessage(conv, "never mind", ctx, c2.emit);

    expect(c2.types()).toEqual(["tool_result", "message"]);
    expect(conv.pending).toBeUndefined();
    expect(await titlesInApi()).toEqual(["Lunch with client"]);
  });

  it("confirming with the wrong callId runs nothing", async () => {
    const { conv } = await requestDeletion();
    const c2 = collector();
    await createAgent({ createResponse: fakeModel().createResponse, mcp, model: "x" }).confirm(conv, "other", true, ctx, c2.emit);
    expect(c2.types()).toEqual(["error"]);
    expect(await titlesInApi()).toEqual(["Lunch with client"]);
  });
});

describe("batch (the case that used to hang: a recurrence created one event at a time)", () => {
  it("recurrence: a single tool call creates the whole series and the loop ends", async () => {
    const m = fakeModel(
      callTool("create_recurring_events", {
        title: "Jiu-jitsu",
        weekdays: ["mon", "wed", "fri"],
        startTime: "19:30",
        endTime: "20:30",
        from: "2026-11-20",
        to: "2026-12-31",
      }),
      reply("Created 18 jiu-jitsu sessions until Dec 31."),
    );
    const c = collector();
    await createAgent({ createResponse: m.createResponse, mcp, model: "x" }).sendMessage(
      newConversation(),
      "jiu-jitsu mon/wed/fri 7:30pm until the end of the year",
      ctx,
      c.emit,
    );
    expect(c.types()).toEqual(["tool_call", "tool_result", "message"]);
    expect(c.events[1]).toMatchObject({ mutated: true, isError: false, data: { total: 18 } });
    expect(await titlesInApi()).toHaveLength(18);
    expect(m.requests).toHaveLength(2);
  });

  it("batch delete: one confirmation summarizing all of them", async () => {
    const r = await api.inject({
      method: "POST",
      url: "/events/batch",
      payload: {
        events: ["2026-11-23", "2026-11-25", "2026-11-27"].map((d) => ({
          title: "Jiu-jitsu",
          start: `${d}T19:30:00-03:00`,
          end: `${d}T20:30:00-03:00`,
        })),
      },
    });
    const ids = (r.json().events as { id: string }[]).map((e) => e.id);
    const conv = newConversation();
    const c = collector();
    await createAgent({ createResponse: fakeModel(callTool("delete_events_batch", { ids })).createResponse, mcp, model: "x" })
      .sendMessage(conv, "cancel all jiu-jitsu", ctx, c.emit);

    expect(c.types()).toEqual(["confirmation"]);
    expect((c.events[0] as { summary: string }).summary).toBe(
      "Delete 3 event(s): 3× “Jiu-jitsu” (Mon, 11/23 → Fri, 11/27)",
    );
    expect(await titlesInApi()).toHaveLength(3);

    const c2 = collector();
    await createAgent({ createResponse: fakeModel(reply("Deleted.")).createResponse, mcp, model: "x" }).confirm(
      conv,
      conv.pending!.call_id,
      true,
      ctx,
      c2.emit,
    );
    expect(c2.events[1]).toMatchObject({ type: "tool_result", mutated: true, data: { deleted: 3 } });
    expect(await titlesInApi()).toEqual([]);
  });
});

describe("HTTP /chat (SSE)", () => {
  function parseSse(body: string): ChatEvent[] {
    return body
      .split("\n\n")
      .filter((b) => b.startsWith("data: "))
      .map((b) => JSON.parse(b.slice(6)) as ChatEvent);
  }

  it("streams start → events → done and reuses the conversation", async () => {
    const m = fakeModel(reply("Hi!"), reply("Again!"));
    const app = buildChatApp({ agent: createAgent({ createResponse: m.createResponse, mcp, model: "x" }) });
    const r1 = await app.inject({ method: "POST", url: "/chat", payload: { text: "hi", ...ctx } });
    expect(r1.headers["content-type"]).toContain("text/event-stream");
    const ev1 = parseSse(r1.body);
    expect(ev1.map((e) => e.type)).toEqual(["start", "message", "done"]);
    const conversationId = (ev1[0] as { conversationId: string }).conversationId;

    const r2 = await app.inject({ method: "POST", url: "/chat", payload: { conversationId, text: "again", ...ctx } });
    expect(parseSse(r2.body)[0]).toEqual({ type: "start", conversationId });
    // accumulated history: the 2nd model request contains the 1st question
    expect(JSON.stringify(m.requests[1]!.input)).toContain("hi");
    await app.close();
  });

  it("an OpenAI error becomes a readable error event, no stack", async () => {
    const createResponse: CreateResponse = async () => {
      throw Object.assign(new Error("Incorrect API key"), { status: 401 });
    };
    const app = buildChatApp({ agent: createAgent({ createResponse, mcp, model: "x" }) });
    app.log.level = "silent";
    const r = await app.inject({ method: "POST", url: "/chat", payload: { text: "hi", ...ctx } });
    expect(parseSse(r.body)).toContainEqual({
      type: "error",
      message: "The OpenAI key was rejected (401). Check OPENAI_API_KEY / OPENAI_ENV_FILE.",
    });
    await app.close();
  });

  it("400 for an invalid body", async () => {
    const app = buildChatApp({ agent: createAgent({ createResponse: fakeModel().createResponse, mcp, model: "x" }) });
    const r = await app.inject({ method: "POST", url: "/chat", payload: { text: "" } });
    expect(r.statusCode).toBe(400);
    await app.close();
  });
});
