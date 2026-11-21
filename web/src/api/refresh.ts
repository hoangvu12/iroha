import { type QueryClient, useQueryClient } from "@tanstack/react-query";

const NOT_CONFIGURATION = new Set<unknown>([
  "session",
  "readyz",
  "requests",
  "logo-check",
]);

export function refreshConfiguration(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ predicate: (q) => !NOT_CONFIGURATION.has(q.queryKey[0]) });
}

export function useRefreshConfiguration(): () => Promise<void> {
  const qc = useQueryClient();
  return () => refreshConfiguration(qc);
}
