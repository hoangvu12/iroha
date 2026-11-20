import { type QueryClient, useQueryClient } from "@tanstack/react-query";

// Query families that never show configuration: a change to configuration,
// or the revert of one, leaves them as they are. Every other family (the
// pages' lists, the record sheets, the chat's model and key choices) is
// configuration or derived from it. (UI ticket 32)
const NOT_CONFIGURATION = new Set<unknown>([
  "session", // the auth gate's own state
  "readyz", // polled on its own
  "requests", // history; the feed follows its own cursor
  "logo-check", // keyed by the logo URL looked up
]);

/**
 * Marks every cached answer that shows configuration stale; the ones on screen
 * refetch now, the others when next shown. Resolves once those refetches are
 * in, so an inline result shows on fresh data. For changes that can touch any
 * record: an Audit Entry's revert.
 */
export function refreshConfiguration(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ predicate: (q) => !NOT_CONFIGURATION.has(q.queryKey[0]) });
}

export function useRefreshConfiguration(): () => Promise<void> {
  const qc = useQueryClient();
  return () => refreshConfiguration(qc);
}
