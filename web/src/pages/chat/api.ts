import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { Shape } from "@/pages/requests/api";
import { asList, asObject, asString, numberOr, optionalString, stringOr } from "@/pages/requests/json";

export type { Shape };
export type Reasoning = "off" | "low" | "medium" | "high";

export const SHAPES: { value: Shape; label: string }[] = [
  { value: "openai-chat", label: "OpenAI Chat" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "gemini", label: "Gemini" },
];
export const shapeLabel = (s: Shape) => SHAPES.find((x) => x.value === s)?.label ?? s;

export type Settings = {
  model: string;
  shape: Shape;
  upstreamKey?: string;
  endpoint?: string;
  as?: string;
  reasoning: Reasoning;
  tools: string[];
};

export const DEFAULT_SETTINGS: Settings = { model: "", shape: "openai-chat", reasoning: "off", tools: [] };

export const WEATHER_TOOL = "get_weather";

export type LegacySettings = Omit<Settings, "tools"> & { tools?: string[]; toolCheck?: boolean };

export function migrateLegacySettings(s: LegacySettings): Settings {
  const { toolCheck, tools, ...rest } = s;
  return { ...rest, tools: Array.isArray(tools) ? tools : toolCheck ? [WEATHER_TOOL] : [] };
}

export type TestTool = { name: string; description: string; parameters: unknown };

export function useTestTools(enabled = true) {
  return useQuery({
    queryKey: ["test-tools"],
    enabled,
    queryFn: ({ signal }) => api.get<{ tools: TestTool[] }>("/api/test/tools", { signal }),
    select: (r) => r.tools,
    staleTime: Infinity,
  });
}

export function providerOf(model: string): string | undefined {
  const i = model.indexOf("/");
  return i > 0 ? model.slice(0, i) : undefined;
}

export function bareModel(model: string): string {
  const i = model.indexOf("/");
  return i > 0 ? model.slice(i + 1) : model;
}

export type ToolCall = { id?: string; name: string; arguments: string };
export type Message = { role: "user" | "assistant"; content: string; tool_calls?: ToolCall[] };
export type ToolCheck = { passed: boolean; reason: string; name?: string; arguments?: string; id?: string; calls?: number };

export type ModelChoice = { id: string; model: string; context_length?: number; reasoning?: boolean; reasoning_levels?: string[]; maker?: string };
export type ModelChoices = {
  total: number;
  matched: number;
  pools: ModelChoice[];
  providers: { provider: string; matched: number; models: ModelChoice[] }[];
  truncated: boolean;
  suggested?: string;
};

export type Snippets = { url: string; curl: string; python: string; typescript: string; key_env: boolean };

export function useModelChoices(q: string, as: string | undefined, prefer?: string, enabled = true) {
  return useQuery({
    queryKey: ["test-models", q, as ?? "", prefer ?? ""],
    enabled,
    queryFn: ({ signal }) => api.get<ModelChoices>("/api/test/models", { signal, query: { q, as, prefer, limit: 300 } }),
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
          tools: s.tools.length ? s.tools.join(",") : undefined,
          prompt: prompt || undefined,
          upstream_key: s.upstreamKey,
          endpoint: s.endpoint,
          base_url: window.location.origin,
        },
      }),
  });
}

export async function suggestedModelOf(handle: string): Promise<string | undefined> {
  const r = await api.get<ModelChoices>("/api/test/models", { query: { prefer: `${handle}/`, limit: 1 } });
  return r.suggested || undefined;
}

export function preferOf(model: string): string | undefined {
  if (!model) return undefined;
  const p = providerOf(model);
  return p ? `${p}/` : model;
}

export async function firstModelFor(as: string): Promise<string | undefined> {
  const r = await api.get<ModelChoices>("/api/test/models", { query: { as, limit: 1 } });
  return r.pools[0]?.id ?? r.providers[0]?.models[0]?.id;
}

export type StreamEvent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; index: number; id?: string; name?: string; args?: string; replace?: boolean }
  | { kind: "error"; message: string }
  | { kind: "tool_check"; check: ToolCheck };

export type SendResult = { requestId?: string; status: number; error?: string };

export function sendBody(s: Settings, system: string | undefined, messages: Message[]) {
  return {
    model: s.model,
    shape: s.shape,
    system: system || undefined,
    messages,
    reasoning: s.reasoning,
    tools: s.tools.length ? s.tools : undefined,
    upstream_key: s.upstreamKey || undefined,
    endpoint: s.endpoint || undefined,
    as: s.as || undefined,
    stream: true,
  };
}

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
    let message = `Iroha answered ${res.status}.`;
    let hint = "";
    try {
      const e = JSON.parse(await res.text())?.error;
      if (typeof e?.message === "string") message = e.message;
      if (!requestId && typeof e?.hint === "string") hint = e.hint;
    } catch {}
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
        } catch {}
      } else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length === 0) return;
    const payload = data.join("\n");
    if (payload === "[DONE]") return;
    try {
      read(event, JSON.parse(payload), wrap);
    } catch {}
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

type Reader = (event: string, json: unknown, on: (e: StreamEvent) => void) => void;

function shapeReader(shape: Shape): Reader {
  switch (shape) {
    case "openai-chat":
      return (_event, json, on) => {
        const j = asObject(json);
        if (!j) return;
        if (j.error) return on({ kind: "error", message: stringOr(asObject(j.error)?.message, "The stream failed.") });
        for (const c of asList(j.choices)) {
          const d = asObject(asObject(c)?.delta) ?? {};
          const r = d.reasoning_content ?? d.reasoning;
          if (typeof r === "string" && r) on({ kind: "reasoning", text: r });
          if (typeof d.content === "string" && d.content) on({ kind: "text", text: d.content });
          for (const t of asList(d.tool_calls)) {
            const call = asObject(t) ?? {};
            const fn = asObject(call.function);
            on({ kind: "tool", index: numberOr(call.index, 0), id: optionalString(call.id), name: optionalString(fn?.name), args: optionalString(fn?.arguments) });
          }
        }
      };
    case "openai-responses": {
      const items: Record<string, number> = {};
      return (event, json, on) => {
        const j = asObject(json);
        if (!j) return;
        const type = stringOr(j.type, event);
        switch (type) {
          case "response.output_text.delta":
            return on({ kind: "text", text: asString(j.delta) });
          case "response.reasoning_summary_text.delta":
          case "response.reasoning_text.delta":
            return on({ kind: "reasoning", text: asString(j.delta) });
          case "response.output_item.added":
          case "response.output_item.done": {
            const item = asObject(j.item);
            if (item?.type === "function_call") {
              const index = (items[String(item.id ?? item.call_id)] ??= Object.keys(items).length);
              on({ kind: "tool", index, id: optionalString(item.call_id), name: optionalString(item.name), args: optionalString(item.arguments), replace: type === "response.output_item.done" });
            }
            return;
          }
          case "error":
            return on({ kind: "error", message: stringOr(asObject(j.error)?.message, stringOr(j.message, "The stream failed.")) });
          case "response.failed":
            return on({ kind: "error", message: stringOr(asObject(asObject(j.response)?.error)?.message, "The response failed.") });
        }
      };
    }
    case "anthropic-messages":
      return (event, json, on) => {
        const j = asObject(json);
        if (!j) return;
        const type = stringOr(j.type, event);
        if (type === "error") return on({ kind: "error", message: stringOr(asObject(j.error)?.message, "The stream failed.") });
        const block = asObject(j.content_block);
        if (type === "content_block_start" && block?.type === "tool_use")
          return on({ kind: "tool", index: numberOr(j.index, 0), id: optionalString(block.id), name: optionalString(block.name) });
        if (type === "content_block_delta") {
          const d = asObject(j.delta) ?? {};
          if (d.type === "text_delta") on({ kind: "text", text: asString(d.text) });
          else if (d.type === "thinking_delta") on({ kind: "reasoning", text: asString(d.thinking) });
          else if (d.type === "input_json_delta") on({ kind: "tool", index: numberOr(j.index, 0), args: asString(d.partial_json) });
        }
      };
    case "gemini": {
      let calls = 0;
      return (_event, json, on) => {
        const j = asObject(json);
        if (!j) return;
        if (j.error) return on({ kind: "error", message: stringOr(asObject(j.error)?.message, "The stream failed.") });
        for (const c of asList(j.candidates))
          for (const part of asList(asObject(asObject(c)?.content)?.parts)) {
            const p = asObject(part);
            if (!p) continue;
            const fc = asObject(p.functionCall);
            if (fc) on({ kind: "tool", index: calls++, id: optionalString(fc.id), name: optionalString(fc.name), args: JSON.stringify(fc.args ?? {}), replace: true });
            else if (typeof p.text === "string" && p.text) on({ kind: p.thought ? "reasoning" : "text", text: p.text });
          }
      };
    }
  }
}
