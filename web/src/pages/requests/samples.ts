import type { Attempt, Capture, FilterOptions, RequestRecord, Stats } from "./api";

// What the Requests page's skeletons are measured from before any data has
// loaded (ui/Skeleton.tsx): typical lengths, never shown as text.

const at = "2026-11-19T09:41:07.000Z";

function sampleRequest(i: number): RequestRecord {
  return {
    id: `req_sample_${i}`,
    started_at: at,
    finished_at: at,
    state: "completed",
    status: 200,
    caller: { kind: "gateway_key", gateway_key_id: "gk_sample", name: ["zeron-fleet", "linh", "studio-bot"][i % 3] },
    route: "/v1/chat/completions",
    shape_in: "openai-chat",
    shape_out: "openai-chat",
    model: ["qwen3-max", "glm-4.6", "deepseek-v3.2-exp"][i % 3],
    stream: true,
    provider: ["dashscope", "openrouter", "zhipu"][i % 3],
    endpoint: "main",
    upstream_key: "key-07",
    wire_model: "qwen3-max",
    first_byte_ms: 820,
    duration_ms: 4210,
    usage: { input: 1824, output: 412, cache_read: 0, cache_write: 0, cache_write_long: 0, reasoning: 0 },
    attempt_count: 1,
    captured: false,
  };
}

export const SAMPLE_REQUESTS: RequestRecord[] = Array.from({ length: 10 }, (_, i) => sampleRequest(i));

export const SAMPLE_STATS: Stats = {
  requests: 12840,
  in_progress: 2,
  succeeded: 12610,
  failed: 228,
  retried: 341,
  median_duration_ms: 4210,
  median_first_byte_ms: 820,
  cache_hits: 6200,
  tokens: { input: 16_000_000, output: 2_400_000, cache_read: 7_000_000, cache_write: 900_000, cache_write_long: 0, reasoning: 0, total: 18_400_000 },
};

export const SAMPLE_CALLERS: FilterOptions["callers"] = [
  { name: "zeron-fleet", kind: "gateway_key", requests: 812 },
  { name: "linh", kind: "gateway_key", requests: 96 },
  { name: "Test", kind: "test", requests: 4 },
];

export const SAMPLE_ATTEMPTS: Attempt[] = [
  {
    seq: 1,
    started_at: at,
    provider_id: "prv_sample",
    provider: "dashscope",
    endpoint_id: "ep_sample",
    endpoint: "main",
    endpoint_url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    upstream_key_id: "key_sample",
    upstream_key: "key-07",
    wire_model: "qwen3-max",
    shape: "openai-chat",
    status: 200,
    first_byte_ms: 820,
    duration_ms: 4210,
  },
];

/** One Request with its Attempts, for the drawer and the Route view before its own answer arrives. */
export const SAMPLE_REQUEST: RequestRecord = {
  ...sampleRequest(0),
  id: "req_sample_0000000000",
  attempts: SAMPLE_ATTEMPTS,
  affinity: { source: "claude_code", mode: "on", preferred_served: true },
};

export const SAMPLE_CAPTURE: Capture = {
  request_id: "req_sample",
  captured_at: at,
  request: { content_type: "application/json", body: { model: "qwen3-max", messages: [{ role: "user", content: "Summarise this page in one line." }] } },
  response: { status: 200, content_type: "application/json", body: { choices: [{ message: { role: "assistant", content: "A sample answer of one line." } }] } },
};
