import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { forgetShapes } from "skullet";
import { api } from "./client";

export type OwnerSession = {
  id: string;
  user_agent: string;
  created_at: string;
  expires_at: string;
  last_seen_at?: string;
  active: boolean;
  revoked_at?: string;
  current: boolean;
};

export type SessionStatus = {
  password_set: boolean;
  signed_in: boolean;
  session?: OwnerSession;
};

export const sessionKey = ["session"] as const;

export function useSession() {
  return useQuery({
    queryKey: sessionKey,
    queryFn: ({ signal }) => api.get<SessionStatus>("/api/session", { signal }),
    staleTime: Infinity,
    retry: 2,
  });
}

export function useSignIn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (password: string) => api.post<SessionStatus>("/api/session", { password }),
    onSuccess: (st) => {
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== sessionKey[0] });
      qc.setQueryData(sessionKey, st);
    },
  });
}

export function useSetUpPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ adminToken, password }: { adminToken: string; password: string }) => {
      await api.put("/api/owner-password", { password }, { headers: { Authorization: `Bearer ${adminToken.trim()}` } });
      return api.post<SessionStatus>("/api/session", { password });
    },
    onSuccess: (st) => qc.setQueryData(sessionKey, st),
  });
}

export function useSignOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<void>("/api/session"),
    onSettled: () => {
      qc.setQueryData<SessionStatus>(sessionKey, { password_set: true, signed_in: false });
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== sessionKey[0] });
      forgetShapes();
    },
  });
}
