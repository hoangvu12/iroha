import { useQuery } from "@tanstack/react-query";
import { ApiError, api } from "@/api/client";
import type { Health } from "@/api/types";

export type HealthState =
  | { state: "checking" }
  | { state: "ready"; version: string }
  | { state: "not_ready"; message: string; call: string }
  | { state: "unreachable"; message: string; call: string };

const POLL_MS = 15_000;

/** Readiness from GET /readyz, polled every 15 s and on focus. */
export function useHealth(): HealthState {
  const q = useQuery({
    queryKey: ["readyz"],
    queryFn: ({ signal }) => api.get<Health>("/readyz", { signal, timeoutMs: 5000 }),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
    staleTime: 0,
  });
  if (q.data && !q.isError) return { state: "ready", version: q.data.version };
  if (q.error instanceof ApiError) {
    return q.error.status === 0
      ? { state: "unreachable", message: q.error.message, call: q.error.call }
      : { state: "not_ready", message: q.error.message, call: q.error.call };
  }
  return { state: "checking" };
}

export function healthLabel(h: HealthState): string {
  switch (h.state) {
    case "ready":
      return `Iroha ${h.version} is ready`;
    case "checking":
      return "Checking Iroha";
    case "not_ready":
      return "Iroha isn't ready";
    case "unreachable":
      return "Iroha isn't answering";
  }
}
