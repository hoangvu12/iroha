import { afterEach, expect, test, vi } from "vitest";
import type { Shape, StreamEvent } from "./api";
import { DEFAULT_SETTINGS, sendBody, streamTurn } from "./api";

afterEach(() => vi.unstubAllGlobals());

async function read(shape: Shape, events: (object | string)[]): Promise<{ events: StreamEvent[]; error?: string }> {
  const sse = events.map((e) => (typeof e === "string" ? e : `data: ${JSON.stringify(e)}`) + "\n\n").join("");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { headers: { "content-type": "text/event-stream", "x-request-id": "req_1" } })));
  const seen: StreamEvent[] = [];
  const res = await streamTurn(sendBody({ ...DEFAULT_SETTINGS, model: "a/b", shape }, undefined, []), shape, (e) => seen.push(e), new AbortController().signal);
  return { events: seen, error: res.error };
}

test("OpenAI Chat: reasoning, text and tool call deltas; an error envelope fails the turn", async () => {
  const { events } = await read("openai-chat", [
    { choices: [{ delta: { reasoning_content: "hmm" } }] },
    { choices: [{ delta: { content: "Hi" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: "c1", function: { name: "get_weather", arguments: '{"city"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ function: { arguments: ':"Hanoi"}' } }] } }] },
    "data: [DONE]",
  ]);
  expect(events).toEqual([
    { kind: "reasoning", text: "hmm" },
    { kind: "text", text: "Hi" },
    { kind: "tool", index: 1, id: "c1", name: "get_weather", args: '{"city"' },
    { kind: "tool", index: 0, id: undefined, name: undefined, args: ':"Hanoi"}' },
  ]);
  expect((await read("openai-chat", [{ error: { message: "rate limited" } }])).error).toBe("rate limited");
  expect((await read("openai-chat", [{ error: "boom" }])).error).toBe("The stream failed.");
});

test("OpenAI Responses: text, reasoning, function calls by item and failures", async () => {
  const { events } = await read("openai-responses", [
    { type: "response.reasoning_summary_text.delta", delta: "think" },
    { type: "response.output_text.delta", delta: "Hi" },
    { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_time", arguments: "" } },
    { type: "response.output_item.added", item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "calculate", arguments: "" } },
    { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_time", arguments: "{}" } },
  ]);
  expect(events).toEqual([
    { kind: "reasoning", text: "think" },
    { kind: "text", text: "Hi" },
    { kind: "tool", index: 0, id: "call_1", name: "get_time", args: "", replace: false },
    { kind: "tool", index: 1, id: "call_2", name: "calculate", args: "", replace: false },
    { kind: "tool", index: 0, id: "call_1", name: "get_time", args: "{}", replace: true },
  ]);
  expect((await read("openai-responses", ["event: error\ndata: {\"message\":\"bad\"}"])).error).toBe("bad");
  expect((await read("openai-responses", [{ type: "response.failed", response: { error: { message: "nope" } } }])).error).toBe("nope");
});

test("Anthropic Messages: thinking, text and tool input deltas", async () => {
  const { events, error } = await read("anthropic-messages", [
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hm" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hi" } },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "get_weather" } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{}" } },
  ]);
  expect(error).toBeUndefined();
  expect(events).toEqual([
    { kind: "reasoning", text: "hm" },
    { kind: "text", text: "Hi" },
    { kind: "tool", index: 2, id: "toolu_1", name: "get_weather" },
    { kind: "tool", index: 2, args: "{}" },
  ]);
  expect((await read("anthropic-messages", [{ type: "error", error: { message: "overloaded" } }])).error).toBe("overloaded");
});

test("Gemini: thought and text parts, function calls numbered in order", async () => {
  const { events } = await read("gemini", [
    { candidates: [{ content: { parts: [{ text: "hm", thought: true }, { text: "Hi" }] } }] },
    { candidates: [{ content: { parts: [{ functionCall: { name: "get_time", args: { tz: "UTC" } } }, { functionCall: { id: "g2", name: "calculate" } }] } }] },
  ]);
  expect(events).toEqual([
    { kind: "reasoning", text: "hm" },
    { kind: "text", text: "Hi" },
    { kind: "tool", index: 0, id: undefined, name: "get_time", args: '{"tz":"UTC"}', replace: true },
    { kind: "tool", index: 1, id: "g2", name: "calculate", args: "{}", replace: true },
  ]);
  expect((await read("gemini", [{ error: { message: "quota" } }])).error).toBe("quota");
});
