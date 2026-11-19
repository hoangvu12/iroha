import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, seg } from "@/api/client";
import type { OwnerSession } from "@/api/session";
import type { AuditEntryPage, AuditResult, BulkResult } from "@/api/types";

// Types and hooks of the Settings page: Admin Tokens, Audit Entries, and the
// Owner's password and sessions. They mirror the Go types in
// internal/admintokens, internal/audit and internal/session.

export type AdminToken = {
  id: string;
  name: string;
  note: string;
  secret: string;
  revoked: boolean;
  created_at: string;
  revoked_at?: string;
  last_used_at?: string;
};

export type TokenResult = AuditResult & { admin_token: AdminToken };

export type ActorOption = {
  kind: "admin_token" | "owner_session";
  id?: string;
  name: string;
  filter: string;
  entries: number;
  last_at: string;
};

export type ResourceOption = { name: string; label: string; plural: string; entries: number };

export type FilterOptions = { actors: ActorOption[]; resources: ResourceOption[] };

export const keys = {
  tokens: ["admin-tokens"] as const,
  entries: ["audit-entries"] as const,
  filters: ["audit-entries", "filters"] as const,
  sessions: ["owner-sessions"] as const,
};

/** Active Admin Tokens, oldest first. */
export function useAdminTokens() {
  return useQuery({
    queryKey: keys.tokens,
    queryFn: ({ signal }) =>
      api.get<{ admin_tokens: AdminToken[] }>("/api/admin-tokens", { signal, query: { revoked: false } }).then((r) => r.admin_tokens),
  });
}

/** Every write here also writes an Audit Entry, and a revert can touch any list, so all of them refetch. */
export function useInvalidateAll() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: keys.tokens });
    void qc.invalidateQueries({ queryKey: keys.entries });
    void qc.invalidateQueries({ queryKey: keys.sessions });
  };
}

export function useCreateAdminToken() {
  const done = useInvalidateAll();
  return useMutation({
    mutationFn: (body: { name: string; note?: string }) => api.post<TokenResult>("/api/admin-tokens", body),
    onSettled: done,
  });
}

export function useRevokeAdminToken() {
  const done = useInvalidateAll();
  return useMutation({
    mutationFn: (id: string) => api.post<TokenResult>(`/api/admin-tokens/${seg(id)}/revoke`),
    onSettled: done,
  });
}

export type EntryFilter = { q: string; actor: string; resource: string };

const PAGE = 50;

/** Audit Entries newest first, a page at a time ("Show older" reads the next). */
export function useAuditEntries(f: EntryFilter) {
  return useInfiniteQuery({
    queryKey: [...keys.entries, "list", f],
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) =>
      api.get<AuditEntryPage>("/api/audit-entries", {
        signal,
        query: { q: f.q, actor: f.actor, resource: f.resource, before: pageParam, limit: PAGE },
      }),
    getNextPageParam: (last) => last.next_before ?? undefined,
  });
}

export function useAuditFilters() {
  return useQuery({
    queryKey: keys.filters,
    queryFn: ({ signal }) => api.get<FilterOptions>("/api/audit-entries/filters", { signal }),
  });
}

/** Active Owner sessions, newest first. */
export function useOwnerSessions() {
  return useQuery({
    queryKey: keys.sessions,
    queryFn: ({ signal }) =>
      api.get<{ owner_sessions: OwnerSession[] }>("/api/owner-sessions", { signal, query: { active: true } }).then((r) => r.owner_sessions),
  });
}

export function useRevokeOwnerSession() {
  const done = useInvalidateAll();
  return useMutation({
    mutationFn: (id: string) => api.post<AuditResult>(`/api/owner-sessions/${seg(id)}/revoke`),
    onSettled: done,
  });
}

export function useRevokeOtherSessions() {
  const done = useInvalidateAll();
  return useMutation({
    mutationFn: (ids: string[]) => api.post<BulkResult<OwnerSession>>("/api/owner-sessions/bulk/revoke", { items: ids }),
    onSettled: done,
  });
}

export function useChangePassword() {
  const done = useInvalidateAll();
  return useMutation({
    mutationFn: (body: { current_password: string; password: string }) => api.put<AuditResult>("/api/owner-password", body),
    onSettled: done,
  });
}
