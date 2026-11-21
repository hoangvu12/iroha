import type { GatewayKey } from "./api";

const at = "2026-11-19T09:41:07.000Z";

const sampleKey = (name: string, i: number): GatewayKey => ({
  id: `gk_sample_${i}`,
  name,
  secret: "iroha_gk_sample00000000000000000000",
  scope: { all: true },
  capture: false,
  revoked: false,
  created_at: at,
  last_used_at: at,
  recent_requests: 128,
});

export const SAMPLE_GATEWAY_KEYS: GatewayKey[] = ["zeron-fleet", "linh", "studio-bot", "nightly-evals", "home-assistant"].map(sampleKey);

export const SAMPLE_GATEWAY_KEY: GatewayKey = sampleKey("zeron-fleet", 0);

export const SAMPLE_MODEL_IDS: string[] = ["qwen3-max", "qwen3-coder-plus", "qwen-plus-latest", "qwen-turbo", "qwen3-vl-plus", "qwen-flash"];

export const SAMPLE_SCOPE_ROWS: { shownProviders: { handle: string; enabled: boolean; gone: boolean }[]; shownPools: string[] } = {
  shownProviders: ["dashscope", "openrouter", "zhipu", "moonshot"].map((handle) => ({ handle, enabled: true, gone: false })),
  shownPools: ["glm-4.6"],
};
