import { useCallback } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Stats, StatsGroup } from "@/pages/requests/api";
import { api, type ApiError, isApiError, seg } from "@/api/client";
import type { AuditResult, BulkResult } from "@/api/types";

export type Shape = "openai-chat" | "openai-responses" | "anthropic-messages" | "gemini";
export const SHAPES: { value: Shape; label: string }[] = [
  { value: "openai-chat", label: "OpenAI Chat" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "gemini", label: "Gemini" },
];
export const shapeLabel = (s: string) => SHAPES.find((x) => x.value === s)?.label ?? s;

export type AuthStyle = "bearer" | "x-api-key" | "header" | "query" | "none";

export const AUTH_STYLES: { value: AuthStyle; label: string }[] = [
  { value: "bearer", label: "Authorization: Bearer <key>" },
  { value: "x-api-key", label: "x-api-key: <key>" },
  { value: "header", label: "A header you name" },
  { value: "query", label: "A query parameter you name" },
  { value: "none", label: "Not sent (no key needed)" },
];

export function authStyleLabel(style: string, param?: string): string {
  if (style === "header" && param) return `${param}: <key>`;
  if (style === "query" && param) return `?${param}=<key>`;
  return AUTH_STYLES.find((a) => a.value === style)?.label ?? style;
}

export type Endpoint = {
  id: string;
  provider: string;
  name: string;
  url: string;
  shape: Shape;
  auth_style: AuthStyle;
  auth_param?: string;
  static_headers: Record<string, string>;
  renames: Record<string, string>;
  discovery_url: string;
  cache_markers?: CacheSetting;
  send_prompt_cache_key?: CacheSetting;
  caching?: { markers: string; prompt_cache_key: boolean; summary: string };
  created_at: string;
};

export type CacheSetting = "" | "on" | "off";

export const CACHE_SETTINGS: { value: CacheSetting; label: string }[] = [
  { value: "", label: "Iroha's default" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];

export const cacheSettingLabel = (s?: CacheSetting) => CACHE_SETTINGS.find((c) => c.value === (s ?? ""))!.label;

export type Provider = {
  id: string;
  handle: string;
  name: string;
  enabled: boolean;
  archived: boolean;
  caller_path: string;
  created_at: string;
  budget: { max_attempts: number; first_byte_seconds: number; overridden: boolean };
  strict: boolean;
  discovery: "none" | "provider" | "key";
  affinity: "on" | "off";
  models_dev_brand: string;
  logo_domain: string;
  logo_domain_guessed: boolean;
  endpoints: Endpoint[];
  upstream_key_count: number;
};

export type KeyStateName = "active" | "disabled" | "invalid" | "cooling";

export type KeyState = {
  state: KeyStateName;
  reason?: string;
  rule?: string;
  request_id?: string;
  since?: string;
  until?: string;
};

export type ModelCooling = { model: string; reason: string; rule?: string; request_id?: string; since: string; until: string };
export type ModelGap = { model: string; reason: string; rule?: string; request_id?: string; created_at: string; expires_at: string };
export type EndpointGap = { endpoint_id: string; endpoint: string; reason: string; rule?: string; request_id?: string; created_at: string };
export type EndpointSuccess = { endpoint_id: string; endpoint: string; succeeded_at: string };

export type UpstreamKey = {
  id: string;
  provider: string;
  name: string;
  secret: string;
  enabled: boolean;
  state: KeyState;
  cooling_models: ModelCooling[];
  model_gaps: ModelGap[];
  endpoints: string[];
  endpoint_gaps: EndpointGap[];
  worked_on: EndpointSuccess[];
  created_at: string;
  last_used_at?: string;
};

export type KeyTestResult = {
  provider: string;
  upstream_key: string;
  endpoint: string;
  model: string;
  passed: boolean;
  status: number;
  duration_ms: number;
  rule?: string;
  outcome?: string;
  reason?: string;
  action: string;
  state: KeyState;
};

export type ApiErr = { code: string; message: string; hint?: string };

export type KeyTestBulk = {
  passed: number;
  failed: number;
  items: { index: number; ok: boolean; result?: KeyTestResult; error?: ApiErr }[];
};

export type Facts = {
  context_length?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  reasoning?: boolean;
  reasoning_levels?: string[];
  chat?: "ok" | "unsupported";
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
};

export type KeyEdit = { key: string; enabled?: boolean; endpoints?: string[]; endpoints_add?: string[]; endpoints_remove?: string[] };

export type FactsPatch = { [K in keyof Facts]?: Facts[K] | null };

export type Model = {
  id: string;
  model: string;
  discovered: boolean;
  added: boolean;
  hidden: boolean;
  visible: boolean;
  endpoints: string[];
  upstream_keys: string[];
  model_gaps: string[];
  metadata: Facts;
  overrides: Facts;
  reported: Facts;
  models_dev: Facts;
  discovered_at?: string;
};

export type ModelFilter = "all" | "visible" | "discovered" | "added" | "hidden" | "gaps";
export const MODEL_FILTERS: ModelFilter[] = ["all", "visible", "discovered", "added", "hidden", "gaps"];

export type ModelList = {
  provider: string;
  discovery: string;
  strict: boolean;
  counts: { all: number; visible: number; discovered: number; added: number; hidden: number; gaps: number };
  total: number;
  offset: number;
  limit: number;
  models: Model[];
  last_refresh?: { at: string; outcome: string; summary: string };
};

export type RefreshResult = { summary: string; outcome: string; added: string[]; removed: string[]; discovered: number };

export type { Outcome } from "@/lib/outcomes";
import type { Outcome } from "@/lib/outcomes";
export const OUTCOMES: { value: Outcome; label: string; hint: string }[] = [
  { value: "cooling_key", label: "Cool the key", hint: "Rate limits and quotas: the key rests, then comes back." },
  { value: "cooling_key_model", label: "Cool the key for this model", hint: "A per-model limit: the key keeps serving other models." },
  { value: "model_gap", label: "Record a Model Gap", hint: "The key can't use this model; other keys are tried for it." },
  { value: "invalid", label: "Mark the key invalid", hint: "Bad or revoked keys: never tried again until you change it." },
  { value: "retry_elsewhere", label: "No change, try the next key", hint: "A passing failure (overloaded, 5xx)." },
  { value: "fail_request", label: "Return the error to the Caller", hint: "The Caller's own mistake (a bad request, blocked content)." },
];

export type RuleFields = {
  description?: string;
  provider?: string;
  host?: string;
  status?: string[];
  code?: string[];
  body?: string;
  header?: Record<string, string>;
  outcome: Outcome;
  cooling_seconds?: number;
  reset?: string[];
};

export type Rule = RuleFields & {
  name: string;
  enabled: boolean;
  source: "builtin" | "owner";
  key_effect: string;
  request_effect: string;
  hits: number;
  last_hit_at?: string;
  order: number;
  overrides?: RuleFields & { name: string };
  builtin_key_effect?: string;
};

export type Replay = { attempts: number; changed: number; since: string; rules: { rule: string; now: number; after: number }[] };

export type FailureInput = { status: number; body?: string; headers?: Record<string, string>; model?: string; endpoint?: string; translated?: boolean };

export type Classification = {
  dry_run: boolean;
  provider: string;
  endpoint?: string;
  host?: string;
  failure: boolean;
  rule?: string;
  outcome?: Outcome;
  status: number;
  embedded: boolean;
  reason?: string;
  key_effect: string;
  request_effect: string;
  cooling_seconds?: number;
  cooling_from?: "response" | "rule" | "default";
};

export type Member = { position: number; provider: string; model: string; enabled: boolean };
export type MemberInput = { provider: string; model: string; enabled: boolean };

export type Pool = {
  id: string;
  name: string;
  maker: string;
  maker_guessed: boolean;
  members: Member[];
  budget: { max_attempts: number; first_byte_seconds: number };
  created_at: string;
};

export type KeyCounts = { total: number; active: number; disabled: number; invalid: number; cooling: number; keyless: number };
export type Traffic = { requests: number; succeeded: number; failed: number; last_request_at?: string };
export type ProviderOverview = { provider: string; keys: KeyCounts; models: number } & Traffic;
export type PoolOverview = { pool: string; served_by: { provider: string; requests: number; succeeded: number }[] } & Traffic;
export type Overview = { since: string; providers: ProviderOverview[]; pools: PoolOverview[] };

export type SkipReason = "disabled" | "invalid" | "cooling" | "cooling_model" | "model_gap" | "restricted" | "endpoint_gap";
export type PreviewSkip = { upstream_key: string; reason: SkipReason; model?: string; endpoint?: string; until?: string; seconds_left?: number };

export type PreviewMember = {
  position: number;
  provider: string;
  model: string;
  enabled: boolean;
  planned: boolean;
  not_planned?: "off" | "provider_unavailable" | "model_not_offered";
  reason?: string;
  keys: number;
  ready_keys: number;
  candidates: { endpoint: string; upstream_key: string; wire_model: string; shape: string; translated: boolean; carrier: boolean }[];
  skipped: PreviewSkip[];
  empty?: { code: string; message: string; until?: string };
};

export type RoutePreview = {
  model: string;
  pool?: string;
  shape: string;
  as?: string;
  at: string;
  ready: number;
  budget: { max_attempts?: number; first_byte_seconds?: number };
  members: PreviewMember[];
  outcome?: { status: number; code: string; message: string; hint: string };
};

export type GatewayKeyLite = { id: string; name: string; revoked: boolean; scope: { all: boolean; pools?: string[] } };

export type ProviderResult = AuditResult & { provider: Provider };
export type EndpointResult = AuditResult & { endpoint: Endpoint; keyless_key?: UpstreamKey };
export type KeyResult = AuditResult & { upstream_key: UpstreamKey };
export type ModelResult = AuditResult & { model: Model };
export type RuleResult = AuditResult & { rule: Rule; replay?: Replay };
export type PoolResult = AuditResult & { pool: Pool };

export const qk = {
  providers: ["providers"] as const,
  provider: (h: string) => ["providers", h] as const,
  keys: (h: string) => ["providers", h, "keys"] as const,
  models: (h: string) => ["providers", h, "models"] as const,
  rules: (h: string) => ["rules", h] as const,
  pools: ["pools"] as const,
  pool: (n: string) => ["pools", n] as const,
  overview: ["overview"] as const,
  preview: (model: string) => ["route-preview", model] as const,
  gatewayKeys: ["providers-page", "gateway-keys"] as const,
};

export function startOfToday(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export function useProviders() {
  return useQuery({
    queryKey: qk.providers,
    queryFn: ({ signal }) => api.get<{ providers: Provider[] }>("/api/providers", { signal }).then((r) => r.providers),
  });
}

export function useProvider(handle: string) {
  return useQuery({
    queryKey: qk.provider(handle),
    queryFn: ({ signal }) => api.get<Provider>(`/api/providers/${seg(handle)}`, { signal }),
    retry: (n, e) => !(isApiError(e) && e.status === 404) && n < 2,
  });
}

export function useOverview() {
  return useQuery({
    queryKey: qk.overview,
    queryFn: ({ signal }) => api.get<Overview>("/api/overview", { signal, query: { since: startOfToday() } }),
    refetchInterval: 15_000,
  });
}

export function useKeys(handle: string) {
  return useQuery({
    queryKey: qk.keys(handle),
    queryFn: ({ signal }) => api.get<{ upstream_keys: UpstreamKey[] }>(`/api/providers/${seg(handle)}/keys`, { signal }).then((r) => r.upstream_keys),
    refetchInterval: 10_000,
  });
}

export function useKeyCache(handle: string) {
  return useQuery({
    queryKey: ["requests", "stats", "key-cache", handle],
    queryFn: ({ signal }) =>
      api.get<Stats>("/api/requests/stats", { signal, query: { provider: handle, group_by: "upstream_key", since: "24h", exclude_tests: "true" } }),
    select: (s): Map<string, StatsGroup> => new Map((s.groups ?? []).filter((g) => g.upstream_key_id).map((g) => [g.upstream_key_id!, g])),
    refetchInterval: 60_000,
  });
}

export function useModels(handle: string, m: { q: string; filter: ModelFilter; offset: number; limit: number }) {
  return useQuery({
    queryKey: [...qk.models(handle), m],
    queryFn: ({ signal }) =>
      api.get<ModelList>(`/api/providers/${seg(handle)}/models`, {
        signal,
        query: { q: m.q, filter: m.filter, offset: m.offset, limit: m.limit },
      }),
    placeholderData: keepPreviousData,
  });
}

export function useModelIds(handle: string | undefined) {
  return useQuery({
    queryKey: [...qk.models(handle ?? ""), "ids"],
    enabled: !!handle,
    queryFn: ({ signal }) =>
      api
        .get<ModelList>(`/api/providers/${seg(handle ?? "")}/models`, { signal, query: { filter: "visible", limit: 500 } })
        .then((r) => r.models.map((m) => m.model)),
  });
}

export function useRules(handle: string) {
  return useQuery({
    queryKey: qk.rules(handle),
    queryFn: ({ signal }) => api.get<{ rules: Rule[] }>("/api/rules", { signal, query: { provider: handle, since: startOfToday() } }).then((r) => r.rules),
  });
}

export function usePools() {
  return useQuery({
    queryKey: qk.pools,
    queryFn: ({ signal }) => api.get<{ pools: Pool[] }>("/api/pools", { signal }).then((r) => r.pools),
  });
}

export function usePool(name: string) {
  return useQuery({
    queryKey: qk.pool(name),
    queryFn: ({ signal }) => api.get<Pool>(`/api/pools/${seg(name)}`, { signal }),
    retry: (n, e) => !(isApiError(e) && e.status === 404) && n < 2,
  });
}

export function useRoutePreview(model: string, shape: Shape) {
  return useQuery({
    queryKey: [...qk.preview(model), shape],
    queryFn: ({ signal }) => api.get<RoutePreview>("/api/route-preview", { signal, query: { model, shape } }),
    refetchInterval: 5_000,
    placeholderData: keepPreviousData,
  });
}

export function useGatewayKeys() {
  return useQuery({
    queryKey: qk.gatewayKeys,
    queryFn: ({ signal }) => api.get<{ gateway_keys: GatewayKeyLite[] }>("/api/gateway-keys", { signal, query: { revoked: false } }).then((r) => r.gateway_keys),
  });
}

export function useRefresh() {
  const qc = useQueryClient();
  return useCallback(
    () =>
      Promise.all(
        [qk.providers, qk.pools, qk.overview, ["rules"], ["route-preview"], ["audit-entries"], qk.gatewayKeys, ["gateway-keys"], ["test-models"]].map((k) =>
          qc.invalidateQueries({ queryKey: k }),
        ),
      ),
    [qc],
  );
}

export function useChange<V, R>(fn: (v: V) => Promise<R>) {
  const refresh = useRefresh();
  return useMutation({ mutationFn: fn, onSettled: refresh });
}

const P = (h: string) => `/api/providers/${seg(h)}`;
const dry = (d?: boolean) => ({ dry_run: d || undefined });

export const nameTaken = (e: unknown): e is ApiError => isApiError(e) && e.code === "name_taken";

export const calls = {
  createProvider: (body: { handle: string; name?: string }) => api.post<ProviderResult>("/api/providers", body),
  updateProvider: (h: string, body: Partial<Pick<Provider, "name" | "enabled" | "archived" | "logo_domain" | "affinity">>) => api.patch<ProviderResult>(P(h), body),

  createEndpoint: (h: string, body: Partial<Endpoint>) => api.post<EndpointResult>(`${P(h)}/endpoints`, body),
  updateEndpoint: (h: string, name: string, body: Partial<Endpoint>) => api.patch<EndpointResult>(`${P(h)}/endpoints/${seg(name)}`, body),
  deleteEndpoint: (h: string, name: string) => api.delete<EndpointResult>(`${P(h)}/endpoints/${seg(name)}`),

  addKeylessKey: (h: string, name: string) => api.post<KeyResult>(`${P(h)}/keys`, { name }),
  addKeys: (h: string, items: { secret: string }[], dryRun?: boolean) => api.post<BulkResult<UpstreamKey>>(`${P(h)}/keys/bulk`, { items }, { query: dry(dryRun) }),
  restrictKeys: (h: string, items: { name: string; endpoints: string[] }[]) => api.put<BulkResult<UpstreamKey>>(`${P(h)}/keys/bulk`, { items }),
  editKeys: (h: string, items: KeyEdit[]) =>
    api.post<BulkResult<UpstreamKey>>(`${P(h)}/keys/bulk/update`, { items }),
  updateKey: (h: string, key: string, body: Partial<Pick<UpstreamKey, "name" | "secret" | "enabled" | "endpoints">>) =>
    api.patch<KeyResult>(`${P(h)}/keys/${seg(key)}`, body),
  bulkKeys: (
    h: string,
    action: "enable" | "disable" | "delete" | "clear-model-gaps" | "clear-endpoint-gaps" | "restrict-to-working-endpoints",
    items: string[],
    model?: string,
  ) =>
    api.post<BulkResult<UpstreamKey>>(`${P(h)}/keys/bulk/${action}`, { items }, { query: { model } }),
  testKeys: (h: string, items: string[]) => api.post<KeyTestBulk>(`${P(h)}/keys/bulk/test`, { items }, { timeoutMs: 180_000 }),
  clearKeyGaps: (h: string, key: string, model?: string) => api.post<KeyResult>(`${P(h)}/keys/${seg(key)}/clear-model-gaps`, {}, { query: { model } }),
  clearEndpointGaps: (h: string, key: string, endpoint?: string) =>
    api.post<KeyResult>(`${P(h)}/keys/${seg(key)}/clear-endpoint-gaps`, {}, { query: { endpoint } }),
  restrictToWorking: (h: string, key: string) => api.post<KeyResult>(`${P(h)}/keys/${seg(key)}/restrict-to-working-endpoints`),

  saveModel: (h: string, body: { model: string; added?: boolean; hidden?: boolean; metadata?: Facts }) => api.post<ModelResult>(`${P(h)}/models`, body),
  saveModels: (h: string, items: { model: string; added?: boolean; hidden?: boolean; metadata?: Facts; metadata_patch?: FactsPatch }[]) =>
    api.post<BulkResult<Model>>(`${P(h)}/models/bulk`, { items }),
  refreshModels: (h: string) => api.post<RefreshResult>(`${P(h)}/models/refresh`, {}, { timeoutMs: 120_000 }),
  resetModels: (h: string) => api.post<{ removed: string[]; kept: number }>(`${P(h)}/models/reset`),

  createRule: (body: RuleFields & { name: string; enabled?: boolean }, dryRun?: boolean) =>
    api.post<RuleResult>("/api/rules", body, { query: dry(dryRun) }),
  putRule: (name: string, body: Partial<RuleFields> & { enabled?: boolean }, dryRun?: boolean) =>
    api.put<RuleResult>(`/api/rules/${seg(name)}`, body, { query: dry(dryRun) }),
  updateRule: (name: string, body: Partial<RuleFields>, dryRun?: boolean) => api.patch<RuleResult>(`/api/rules/${seg(name)}`, body, { query: dry(dryRun) }),
  switchRule: (name: string, on: boolean) => api.post<RuleResult>(`/api/rules/${seg(name)}/${on ? "enable" : "disable"}`),
  deleteRule: (name: string) => api.delete<RuleResult>(`/api/rules/${seg(name)}`),
  classify: (h: string, body: FailureInput) => api.post<Classification>(`${P(h)}/rules/classify`, body),

  pool: (name: string) => api.get<Pool>(`/api/pools/${seg(name)}`),
  createPool: (body: { name: string; members?: MemberInput[]; maker?: string }) => api.post<PoolResult>("/api/pools", body),
  updatePool: (name: string, body: { name?: string; members?: MemberInput[]; maker?: string; budget?: Partial<Pool["budget"]> }) =>
    api.patch<PoolResult>(`/api/pools/${seg(name)}`, body),
  deletePool: (name: string) => api.delete<PoolResult>(`/api/pools/${seg(name)}`),
};

export function maskSecret(s: string): string {
  if (!s) return "no secret";
  const dash = s.indexOf("-");
  const prefix = dash > 0 && dash <= 4 ? s.slice(0, dash + 1) : "";
  return `${prefix}…${s.slice(-4)}`;
}

export const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

export function successRate(t?: Pick<Traffic, "succeeded" | "failed">): number | undefined {
  if (!t) return undefined;
  const done = t.succeeded + t.failed;
  return done ? t.succeeded / done : undefined;
}

export { errorText } from "@/api/client";
