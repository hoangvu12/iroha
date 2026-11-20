import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, seg } from "@/api/client";
import type { AuditResult, BulkResult } from "@/api/types";

// Types and hooks of the Gateway Keys page. They mirror the Go types in
// internal/gatewaykeys (GET /api/gateway-keys), and read the Providers,
// Model Pools and model lists the scope picker offers.

export type ScopeProvider = { provider: string; models?: string[] };
export type Scope = { all: boolean; providers?: ScopeProvider[]; pools?: string[] };

export type GatewayKey = {
  id: string;
  name: string;
  secret: string;
  scope: Scope;
  capture: boolean;
  revoked: boolean;
  created_at: string;
  revoked_at?: string;
  last_used_at?: string;
  /** The key's own Requests of the last 24 hours (test Requests sent as it are not counted). */
  recent_requests: number;
};

export type KeyResult = AuditResult & { gateway_key: GatewayKey };

export type ProviderOption = { id: string; handle: string; name: string; enabled: boolean; archived: boolean };
export type PoolOption = { id: string; name: string; maker: string };

export type ModelEntry = { id: string; model: string; visible: boolean; hidden: boolean };
export type ModelPage = { total: number; offset: number; limit: number; models: ModelEntry[] };

export const keys = {
  all: ["gateway-keys"] as const,
  list: ["gateway-keys", "list"] as const,
  one: (ref: string) => ["gateway-keys", "one", ref] as const,
  providers: ["gateway-keys", "providers"] as const,
  pools: ["gateway-keys", "pools"] as const,
  models: (provider: string, q: string) => ["gateway-keys", "models", provider, q] as const,
};

/** Every Gateway Key, revoked ones included, oldest first. */
export function useGatewayKeys() {
  return useQuery({
    queryKey: keys.list,
    queryFn: ({ signal }) => api.get<{ gateway_keys: GatewayKey[] }>("/api/gateway-keys", { signal }).then((r) => r.gateway_keys),
    refetchInterval: 30_000, // last used and recent Requests move on their own
  });
}

export function useGatewayKey(ref: string) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: keys.one(ref),
    queryFn: ({ signal }) => api.get<GatewayKey>(`/api/gateway-keys/${seg(ref)}`, { signal }),
    placeholderData: () => qc.getQueryData<GatewayKey[]>(keys.list)?.find((k) => k.id === ref || k.name === ref),
    refetchInterval: 30_000,
  });
}

/**
 * After any change (or its Undo) every list and key page refetches, and so do the other places
 * listing Gateway Keys or their scopes: the chat's Send as and model choices, a Pool's Members tab.
 */
export function useInvalidateKeys() {
  const qc = useQueryClient();
  // Resolves once the refetches are in, so an inline result shows on fresh data.
  return () =>
    Promise.all(
      [keys.all, ["audit-entries"], ["providers-page", "gateway-keys"], ["test-models"]].map((k) => qc.invalidateQueries({ queryKey: k })),
    );
}

export function useCreateKey() {
  const done = useInvalidateKeys();
  return useMutation({
    mutationFn: (body: { name: string; scope: Scope; capture?: boolean }) => api.post<KeyResult>("/api/gateway-keys", body),
    onSettled: done,
  });
}

export function useUpdateKey() {
  const done = useInvalidateKeys();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; scope?: Scope; capture?: boolean }) =>
      api.patch<KeyResult>(`/api/gateway-keys/${seg(id)}`, body),
    onSettled: done,
  });
}

/** Edits many keys (by name or ID) in one change and one Audit Entry; fields an item leaves out stay as that key has them (UI ticket 30). */
export const editKeys = (items: { key: string; capture?: boolean }[]) => api.post<BulkResult<GatewayKey>>("/api/gateway-keys/bulk/update", { items });

export function useRevokeKey() {
  const done = useInvalidateKeys();
  return useMutation({
    mutationFn: (id: string) => api.post<KeyResult>(`/api/gateway-keys/${seg(id)}/revoke`),
    onSettled: done,
  });
}

export function useDeleteKey() {
  const done = useInvalidateKeys();
  return useMutation({
    mutationFn: (id: string) => api.delete<KeyResult>(`/api/gateway-keys/${seg(id)}`),
    onSettled: done,
  });
}

/** Providers a scope can name: every unarchived one, by handle. */
export function useProviderOptions() {
  return useQuery({
    queryKey: keys.providers,
    queryFn: ({ signal }) =>
      api
        .get<{ providers: ProviderOption[] }>("/api/providers", { signal, query: { archived: false } })
        .then((r) => [...r.providers].sort((a, b) => a.handle.localeCompare(b.handle))),
    staleTime: 30_000,
  });
}

export function usePoolOptions() {
  return useQuery({
    queryKey: keys.pools,
    queryFn: ({ signal }) =>
      api.get<{ pools: PoolOption[] }>("/api/pools", { signal }).then((r) => [...r.pools].sort((a, b) => a.name.localeCompare(b.name))),
    staleTime: 30_000,
  });
}

export const MODEL_PAGE = 200;

/**
 * A Provider's visible models matching q, a page at a time. Search runs on
 * the server, so a Provider with thousands of models costs one small page.
 */
export function useProviderModels(provider: string | undefined, q: string) {
  return useInfiniteQuery({
    queryKey: keys.models(provider ?? "", q),
    enabled: !!provider,
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      api.get<ModelPage>(`/api/providers/${seg(provider!)}/models`, {
        signal,
        query: { q, filter: "visible", offset: pageParam, limit: MODEL_PAGE },
      }),
    getNextPageParam: (last) => (last.offset + last.models.length < last.total ? last.offset + last.models.length : undefined),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

type Setting = { name: string; value: number };

/** retention.captures_days, for "kept for N days". */
export function useCaptureDays() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => api.get<{ settings: Setting[] }>("/api/settings", { signal }),
    select: (s) => s.settings.find((x) => x.name === "retention.captures_days")?.value,
    staleTime: 60_000,
  });
}
