import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, seg } from "@/api/client";
import type { Shape } from "@/pages/requests/api";

// The test chat's calls (ticket 23): POST /api/test streams one turn in the
// chosen Shape, GET /api/test/models searches what can be picked, GET
// /api/test/snippets writes curl, Python and TypeScript for the settings.
// Types mirror internal/testchat.

export type { Shape };
export type Reasoning = "off" | "low" | "medium" | "high";

export const SHAPES: { value: Shape; label: string }[] = [
  { value: "openai-chat", label: "OpenAI Chat" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "gemini", label: "Gemini" },
];
export const shapeLabel = (s: Shape) => SHAPES.find((x) => x.value === s)?.label ?? s;

/** Everything the composer's model button sets. */
export type Settings = {
  /** A Pool name or <provider>/<model>; "" before one is picked. */
  model: string;
  shape: Shape;
  /** Pinned Upstream Key name (the model's Provider). */
  upstreamKey?: string;
  /** Pinned Endpoint name. */
  endpoint?: string;
  /** Gateway Key name to send as. */
  as?: string;
  reasoning: Reasoning;
  toolCheck: boolean;
};

export const DEFAULT_SETTINGS: Settings = { model: "", shape: "openai-chat", reasoning: "off", toolCheck: false };

/** The Provider handle of a model, or undefined for a Pool. */
export function providerOf(model: string): string | undefined {
  const i = model.indexOf("/");
  return i > 0 ? model.slice(0, i) : undefined;
}

/** The model without its Provider handle. */
export function bareModel(model: string): string {
  const i = model.indexOf("/");
  return i > 0 ? model.slice(i + 1) : model;
}

export type ToolCall = { id?: string; name: string; arguments: string };
export type Message = { role: "user" | "assistant"; content: string; tool_calls?: ToolCall[] };
export type ToolCheck = { passed: boolean; reason: string; name?: string; arguments?: string; id?: string };

export type ModelChoice = { id: string; model: string; context_length?: number; reasoning?: boolean; reasoning_levels?: string[]; maker?: string };
export type ModelChoices = {
  total: number;
  matched: number;
  pools: ModelChoice[];
  providers: { provider: string; matched: number; models: ModelChoice[] }[];
  truncated: boolean;
};

export type Snippets = { url: string; curl: string; python: string; typescript: string; key_env: boolean; note?: string };

export function useModelChoices(q: string, as: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["test-models", q, as ?? ""],
    enabled,
    queryFn: ({ signal }) => api.get<ModelChoices>("/api/test/models", { signal, query: { q, as, limit: 300 } }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function useSnippets(s: Settings, prompt: string, enabled: boolean) {
  return useQuery({
    queryKey: ["test-snippets", s, prompt],
    enabled: enabled && !!s.model,
    queryFn: ({ signal }) =>
      api.get<Snippets>("/api/test/snippets", {
        signal,
        query: {
          model: s.model,
          shape: s.shape,
          as: s.as,
          reasoning: s.reasoning,
          tool_check: s.toolCheck,
          prompt: prompt || undefined,
          upstream_key: s.upstreamKey,
          endpoint: s.endpoint,
          base_url: window.location.origin,
        },
      }),
  });
}

/** The first model a Provider lists, to start a chat opened from it. */
export async function firstModelOf(handle: string): Promise<string | undefined> {
  const r = await api.get<{ models: { model: string }[] }>(`/api/providers/${seg(handle)}/models`, { query: { filter: "visible", limit: 1 } });
  return r.models[0] ? `${handle}/${r.models[0].model}` : undefined;
}

/** The first Pool or model a Gateway Key may use. */
export async function firstModelFor(as: string): Promise<string | undefined> {
  const r = await api.get<ModelChoices>("/api/test/models", { query: { as, limit: 1 } });
  return r.pools[0]?.id ?? r.providers[0]?.models[0]?.id;
}

// ---- Sending one turn ------------------------------------------------------

/** What a streamed answer says, whatever its Shape. */
export type StreamEvent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; index: number; id?: string; name?: string; args?: string; replace?: boolean }
  | { kind: "error"; message: string }
  | { kind: "tool_check"; check: ToolCheck };

export type SendResult = { requestId?: string; status: number; error?: string };

/** The body POST /api/test takes. */
export function sendBody(s: Settings, system: string | undefined, messages: Message[]) {
  return {
    model: s.model,
    shape: s.shape,
    system: system || undefined,
    messages,
    reasoning: s.reasoning,
    tool_check: s.toolCheck,
    upstream_key: s.upstreamKey || undefined,
    endpoint: s.endpoint || undefined,
    as: s.as || undefined,
    stream: true,
  };
}

/**
 * Send one turn and read the answer as it streams. Resolves when the answer
 * ends; a failure before streaming (an error envelope) resolves with error.
 */
export async function streamTurn(body: ReturnType<typeof sendBody>, shape: Shape, on: (e: StreamEvent) => void, signal: AbortSignal): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetch("/api/test", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal.aborted) throw e;
    return { status: 0, error: "Couldn't reach Iroha. Check the connection." };
  }
  const requestId = res.headers.get("x-request-id") ?? undefined;
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("text/event-stream")) {
    if (res.ok) return { requestId, status: res.status };
    // The Shape's error envelope; or, before anything was sent (unknown
    // pin, revoked Gateway Key), the admin one with a hint.
    let message = `Iroha answered ${res.status}.`;
    let hint = "";
    try {
      const e = JSON.parse(await res.text())?.error;
      if (typeof e?.message === "string") message = e.message;
      if (!requestId && typeof e?.hint === "string") hint = e.hint;
    } catch {
      /* not JSON */
    }
    return { requestId, status: res.status, error: hint ? `${message} ${hint}` : message };
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const read = shapeReader(shape);
  let buf = "";
  let failed: string | undefined;
  const wrap = (e: StreamEvent) => {
    if (e.kind === "error") failed = e.message;
    on(e);
  };
  const handle = (block: string) => {
    let event = "";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(": iroha-tool-check ")) {
        try {
          wrap({ kind: "tool_check", check: JSON.parse(line.slice(19)) });
        } catch {
          /* not ours */
        }
      } else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length === 0) return;
    const payload = data.join("\n");
    if (payload === "[DONE]") return;
    try {
      read(event, JSON.parse(payload), wrap);
    } catch {
      /* a keep-alive or something unreadable */
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let end: number;
    while ((end = buf.indexOf("\n\n")) >= 0) {
      handle(buf.slice(0, end));
      buf = buf.slice(end + 2);
    }
  }
  if (buf.trim()) handle(buf);
  return { requestId, status: res.status, error: failed };
}

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** One event reader per Shape, each turning that Shape's events into StreamEvents. */
function shapeReader(shape: Shape) {
  switch (shape) {
    case "openai-chat":
      return (_event: string, j: J, on: (e: StreamEvent) => void) => {
        if (j.error) return on({ kind: "error", message: j.error.message ?? "The stream failed." });
        for (const c of j.choices ?? []) {
          const d = c.delta ?? {};
          const r = d.reasoning_content ?? d.reasoning;
          if (typeof r === "string" && r) on({ kind: "reasoning", text: r });
          if (typeof d.content === "string" && d.content) on({ kind: "text", text: d.content });
          for (const t of d.tool_calls ?? []) on({ kind: "tool", index: t.index ?? 0, id: t.id, name: t.function?.name, args: t.function?.arguments });
        }
      };
    case "openai-responses": {
      const items: Record<string, number> = {};
      return (event: string, j: J, on: (e: StreamEvent) => void) => {
        const type = j.type ?? event;
        switch (type) {
          case "response.output_text.delta":
            return on({ kind: "text", text: j.delta ?? "" });
          case "response.reasoning_summary_text.delta":
          case "response.reasoning_text.delta":
            return on({ kind: "reasoning", text: j.delta ?? "" });
          case "response.output_item.added":
          case "response.output_item.done":
            if (j.item?.type === "function_call") {
              const index = (items[j.item.id ?? j.item.call_id] ??= Object.keys(items).length);
              on({ kind: "tool", index, id: j.item.call_id, name: j.item.name, args: j.item.arguments, replace: type === "response.output_item.done" });
            }
            return;
          case "error":
            return on({ kind: "error", message: j.error?.message ?? j.message ?? "The stream failed." });
          case "response.failed":
            return on({ kind: "error", message: j.response?.error?.message ?? "The response failed." });
        }
      };
    }
    case "anthropic-messages":
      return (event: string, j: J, on: (e: StreamEvent) => void) => {
        const type = j.type ?? event;
        if (type === "error") return on({ kind: "error", message: j.error?.message ?? "The stream failed." });
        if (type === "content_block_start" && j.content_block?.type === "tool_use")
          return on({ kind: "tool", index: j.index ?? 0, id: j.content_block.id, name: j.content_block.name });
        if (type === "content_block_delta") {
          const d = j.delta ?? {};
          if (d.type === "text_delta") on({ kind: "text", text: d.text ?? "" });
          else if (d.type === "thinking_delta") on({ kind: "reasoning", text: d.thinking ?? "" });
          else if (d.type === "input_json_delta") on({ kind: "tool", index: j.index ?? 0, args: d.partial_json ?? "" });
        }
      };
    case "gemini": {
      let calls = 0;
      return (_event: string, j: J, on: (e: StreamEvent) => void) => {
        if (j.error) return on({ kind: "error", message: j.error.message ?? "The stream failed." });
        for (const c of j.candidates ?? [])
          for (const p of c.content?.parts ?? []) {
            if (p.functionCall) on({ kind: "tool", index: calls++, id: p.functionCall.id, name: p.functionCall.name, args: JSON.stringify(p.functionCall.args ?? {}), replace: true });
            else if (typeof p.text === "string" && p.text) on({ kind: p.thought ? "reasoning" : "text", text: p.text });
          }
      };
    }
  }
}
