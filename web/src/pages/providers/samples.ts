import type { Endpoint, GatewayKeyLite, Model, ModelList, Overview, Pool, Provider, RoutePreview, Rule, UpstreamKey } from "./api";

// What the Providers pages' skeletons are measured from before any data has
// loaded (ui/Skeleton.tsx): typical lengths, never shown as text.

const at = "2026-11-19T09:41:07.000Z";

export const SAMPLE_ENDPOINTS: Endpoint[] = ["main", "anthropic"].map((name, i) => ({
  id: `ep_sample_${i}`,
  provider: "dashscope",
  name,
  url: i ? "https://dashscope-intl.aliyuncs.com/apps/anthropic" : "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  shape: i ? "anthropic-messages" : "openai-chat",
  auth_style: "bearer",
  static_headers: {},
  renames: {},
  discovery_url: "",
  created_at: at,
}));

function sampleProvider(handle: string, i: number): Provider {
  return {
    id: `prv_sample_${i}`,
    handle,
    name: handle,
    enabled: true,
    archived: false,
    caller_path: `/providers/${handle}/v1`,
    created_at: at,
    budget: { max_attempts: 0, first_byte_seconds: 0, overridden: false },
    strict: false,
    discovery: "provider",
    models_dev_brand: "",
    logo_domain: "aliyun.com",
    logo_domain_guessed: true,
    endpoints: SAMPLE_ENDPOINTS,
    upstream_key_count: 24,
  };
}

export const SAMPLE_PROVIDER: Provider = sampleProvider("dashscope", 0);

export const SAMPLE_PROVIDERS: Provider[] = ["dashscope", "openrouter", "zhipu", "moonshot", "deepseek"].map(sampleProvider);

export const SAMPLE_KEYS: UpstreamKey[] = Array.from({ length: 10 }, (_, i) => ({
  id: `key_sample_${i}`,
  provider: "dashscope",
  name: `key-${String(i + 1).padStart(2, "0")}`,
  secret: "sk-sample0000000000000000000000",
  enabled: true,
  state: { state: "active" },
  cooling_models: [],
  model_gaps: [],
  endpoints: [],
  endpoint_gaps: [],
  worked_on: [],
  created_at: at,
  last_used_at: at,
}));

const sampleModel = (model: string, i: number): Model => ({
  id: `mdl_sample_${i}`,
  model,
  discovered: true,
  added: false,
  hidden: false,
  visible: true,
  endpoints: [],
  upstream_keys: [],
  model_gaps: [],
  metadata: { context_length: 262_144 },
  overrides: {},
  reported: {},
  models_dev: {},
  discovered_at: at,
});

export const SAMPLE_MODEL_LIST: ModelList = {
  provider: "dashscope",
  discovery: "provider",
  strict: false,
  counts: { all: 120, visible: 120, discovered: 120, added: 0, hidden: 0, gaps: 0 },
  total: 120,
  offset: 0,
  limit: 50,
  models: ["qwen3-max", "qwen3-coder-plus", "qwen-plus-latest", "qwen3-235b-a22b-instruct", "qwen-turbo", "qwen3-vl-plus", "qwen-flash", "qwen3-next-80b-a3b"].map(
    sampleModel,
  ),
  last_refresh: { at, outcome: "ok", summary: "120 models" },
};

// The built-in rules every Provider has (internal/rules/builtin.go), so the
// first skeleton is as long as the real list.
export const SAMPLE_RULES: Rule[] = [
  "insufficient-quota", "credit-balance-too-low", "deepai-pool-spent", "deepai-check-in-refused", "unauthorized",
  "forbidden-model", "forbidden-billing", "forbidden-account", "forbidden", "payment-required", "model-not-found",
  "endpoint-path-not-found", "endpoint-body-too-large", "rate-limited", "upstream-timeout", "server-error", "network",
  "bad-request",
].map((name, i) => ({
  name,
  enabled: true,
  source: "builtin",
  status: ["429"],
  outcome: "cooling_key",
  key_effect: "Cools for 60 s",
  request_effect: "Tries the next key",
  hits: 12,
  order: i,
}));

export const SAMPLE_POOL: Pool = {
  id: "pool_sample",
  name: "glm-4.6",
  maker: "zhipu",
  maker_guessed: true,
  members: ["zhipu", "openrouter", "siliconflow"].map((provider, i) => ({ position: i + 1, provider, model: "glm-4.6", enabled: true })),
  budget: { max_attempts: 0, first_byte_seconds: 0 },
  created_at: at,
};

export const SAMPLE_POOLS: Pool[] = [SAMPLE_POOL, { ...SAMPLE_POOL, id: "pool_sample_2", name: "qwen3-coder" }];

export const SAMPLE_OVERVIEW: Overview = {
  since: at,
  providers: [],
  pools: [{ pool: "glm-4.6", served_by: [], requests: 1280, succeeded: 1270, failed: 10 }],
};

export const SAMPLE_GATEWAY_KEYS_LITE: GatewayKeyLite[] = [{ id: "gk_sample", name: "zeron-fleet", revoked: false, scope: { all: true } }];

export const SAMPLE_PREVIEW: RoutePreview = {
  model: "glm-4.6",
  pool: "glm-4.6",
  shape: "openai-chat",
  at,
  ready: 3,
  budget: {},
  members: SAMPLE_POOL.members.map((m) => ({
    ...m,
    planned: true,
    keys: 4,
    ready_keys: 4,
    candidates: [{ endpoint: "main", upstream_key: "key-01", wire_model: "glm-4.6", shape: "openai-chat", translated: false, carrier: false }],
    skipped: [],
  })),
};
