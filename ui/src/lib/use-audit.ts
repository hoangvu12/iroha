import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import { toApiError } from './api-client.ts'
import { clearAudit, fetchAudit, type AuditFilter } from './audit.ts'
import { queryKeys } from './query-keys.ts'

/**
 * The audit feed as shared server state, plus the one write that empties it.
 * Every other mutation in the UI already invalidates `queryKeys.auditAll()` on
 * settle, so an open audit page picks up the entries those writes append.
 */

/** One screenful of audit events. Also the stride the pager moves by. */
export const AUDIT_PAGE_SIZE = 25

/**
 * One page of the audit feed. Filters and offset are both part of the key, so
 * widening a filter and narrowing it back is served from the cache.
 */
export function useAuditPage(filter: AuditFilter, offset: number) {
  return useQuery({
    ...auditPageQueryOptions(filter, offset),
    // Matches what the screen did before: the page it was showing stays put
    // until the next one lands, rather than collapsing to a skeleton.
    placeholderData: keepPreviousData,
  })
}

/**
 * The key and the fetch behind one page, shared with the route loader that warms
 * the first one. The page size is in here so the loader cannot warm a page size
 * the screen does not ask for.
 */
export function auditPageQueryOptions(filter: AuditFilter, offset: number) {
  return queryOptions({
    queryKey: queryKeys.audit({ ...filter, limit: AUDIT_PAGE_SIZE, offset }),
    queryFn: ({ signal }) => fetchAudit(filter, { limit: AUDIT_PAGE_SIZE, offset, signal }),
  })
}

/**
 * Emptying the feed. Not optimistic and deliberately so: it is destructive, the
 * removed count is the Gateway's to report, and the clear is itself audited —
 * predicting an empty list would hide the entry the clear writes.
 */
export function useClearAudit(csrfToken: string) {
  const client = useQueryClient()

  return useMutation({
    mutationFn: () => clearAudit(csrfToken),
    onError(cause) {
      toast.error('Could not clear the audit feed', {
        description: toApiError(cause).message,
      })
    },
    onSettled() {
      // Every page of the feed, whatever filters the open one is holding.
      void client.invalidateQueries({ queryKey: queryKeys.auditAll() })
    },
  })
}
