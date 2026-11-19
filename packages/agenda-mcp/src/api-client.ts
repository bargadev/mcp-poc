import type { ApiErrorBody, CreateEvent, Event, UpdateEvent } from "@agenda/api/schemas";

/** Error whose message is ready to be shown to the model. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly details?: ApiErrorBody["details"],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function createApiClient({ baseUrl, fetch: f = fetch, timeoutMs = 10_000 }: ApiClientOptions) {
  const base = baseUrl.replace(/\/+$/, "");

  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await f(`${base}${path}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new ApiError(
        `Could not connect to the agenda API at ${base}. Check that it is running (pnpm dev:api) and that AGENDA_API_URL is correct.`,
      );
    }

    if (res.status === 204) return undefined as T;

    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }

    if (!res.ok) {
      const body = json as Partial<ApiErrorBody> | undefined;
      throw new ApiError(
        body?.error ??
          `The API at ${base} responded ${res.status} to ${method} ${path} without an error message. Check that AGENDA_API_URL points to the agenda API.`,
        res.status,
        body?.details,
      );
    }
    return json as T;
  }

  return {
    list(from: string, to: string): Promise<Event[]> {
      const q = new URLSearchParams({ from, to });
      return req("GET", `/events?${q}`);
    },
    get(id: string): Promise<Event> {
      return req("GET", `/events/${encodeURIComponent(id)}`);
    },
    create(data: CreateEvent): Promise<Event> {
      return req("POST", "/events", data);
    },
    update(id: string, data: UpdateEvent): Promise<Event> {
      return req("PATCH", `/events/${encodeURIComponent(id)}`, data);
    },
    delete(id: string): Promise<void> {
      return req("DELETE", `/events/${encodeURIComponent(id)}`);
    },
    createMany(events: CreateEvent[]): Promise<{ events: Event[] }> {
      return req("POST", "/events/batch", { events });
    },
    deleteMany(ids: string[]): Promise<{ deleted: number }> {
      return req("POST", "/events/batch/delete", { ids });
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
