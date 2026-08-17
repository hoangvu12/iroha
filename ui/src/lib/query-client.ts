import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { signOutIfSessionEnded } from './api-client.ts'
import { FOCUS_EXEMPT_KEY_PREFIXES } from './query-keys.ts'

/**
 * One cache for the whole management UI, created at module scope so both `App`
 * and the router can reach it: route loaders call `queryClient.ensureQueryData`,
 * and a client built inside a component body would be a different cache on
 * every render.
 */

/**
 * Long enough that navigating away and back does not refetch, short enough that
 * a Provider changed in another tab shows up without a reload.
 */
const STALE_TIME_MS = 30_000

/**
 * Reads and writes fail the same way, so both caches share one handler. A 401
 * anywhere means the Owner Session is gone; the screen that happened to make
 * the request is not the right place to decide that.
 */
function onError(error: unknown): void {
  signOutIfSessionEnded(error)
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: {
    queries: {
      staleTime: STALE_TIME_MS,
      refetchOnWindowFocus: (query) => !isHistoricalLog(query.queryKey),
    },
  },
})

function isHistoricalLog(queryKey: readonly unknown[]): boolean {
  const prefix = queryKey[0]
  return typeof prefix === 'string' && FOCUS_EXEMPT_KEY_PREFIXES.includes(prefix)
}
