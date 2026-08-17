import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query'
import { queryKeys } from './query-keys.ts'
import {
  fetchRequestDetail,
  fetchRequestOverview,
  fetchRequests,
  type OverviewRange,
  type RequestFilter,
} from './requests.ts'

/**
 * Request history as shared server state. Nothing here mutates: these reads buy
 * deduplication and instant back-navigation rather than optimism, and they are
 * historical logs, so `query-keys` exempts them from refetch-on-focus.
 */

/** One screenful of Request events. Also the stride the pager moves by. */
export const REQUEST_PAGE_SIZE = 25

/**
 * One page of Request history. The filters and the offset are both part of the
 * key, so paging back or returning to a filter the Owner already looked at is
 * served from the cache instead of the database.
 */
export function useRequestPage(filter: RequestFilter, offset: number) {
  return useQuery({
    ...requestPageQueryOptions(filter, offset),
    // The list used to hold the page it was showing until the next one arrived,
    // because the old code only replaced it on success. Without this the key
    // change would empty the table and flash the skeleton between pages.
    placeholderData: keepPreviousData,
  })
}

/**
 * The key and the fetch behind one page, shared with the route loader that warms
 * the first one. The page size lives in here rather than at either call site: a
 * loader that warmed a different `limit` would warm a page the screen never asks
 * for, and the screen would refetch on mount.
 */
export function requestPageQueryOptions(filter: RequestFilter, offset: number) {
  return queryOptions({
    queryKey: queryKeys.requests({ ...filter, limit: REQUEST_PAGE_SIZE, offset }),
    queryFn: ({ signal }) =>
      fetchRequests(filter, { limit: REQUEST_PAGE_SIZE, offset, signal }),
  })
}

/**
 * One Request with its Attempts, for the detail dialog. Keyed by the Request, so
 * reopening a row the Owner already looked at costs no fetch at all.
 */
export function useRequestDetail(requestId: string | null) {
  return useQuery({
    // A disabled query still needs a key; the empty id is never fetched.
    queryKey: queryKeys.request(requestId ?? ''),
    queryFn: ({ queryKey, signal }) => fetchRequestDetail(queryKey[1], signal),
    enabled: requestId !== null,
  })
}

/** The Overview's aggregate over one range. The range is the Owner's to choose. */
export function useRequestOverview(range: OverviewRange) {
  return useQuery(requestOverviewQueryOptions(range))
}

/** The aggregate read, shared with the Overview route's loader. */
export function requestOverviewQueryOptions(range: OverviewRange) {
  return queryOptions({
    queryKey: queryKeys.requestOverview(range),
    queryFn: ({ signal }) => fetchRequestOverview(range, signal),
  })
}
