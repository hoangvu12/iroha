import type { AuditFilter } from './audit.ts'
import type { OverviewRange, RequestFilter } from './requests.ts'

/**
 * The one place a query key is spelled. A key typed by hand at a call site is a
 * cache miss the type checker cannot see, and a mutation that invalidates
 * `['provider']` when the read wrote `['providers']` fails silently.
 */

/** One page of Request history: the filters that select it and the window over it. */
export interface RequestsQuery extends RequestFilter {
  readonly limit?: number
  readonly offset?: number
}

/** One page of the audit feed. */
export interface AuditQuery extends AuditFilter {
  readonly limit?: number
  readonly offset?: number
}

export const queryKeys = {
  providers: () => ['providers'] as const,
  provider: (id: string) => ['providers', id] as const,
  providerTemplates: () => ['provider-templates'] as const,
  gatewayKeys: () => ['gateway-keys'] as const,
  requests: (filters: RequestsQuery = {}) => ['requests', filters] as const,
  /** One Request with its Attempts, as the Requests area's detail dialog reads it. */
  request: (requestId: string) => ['requests', requestId] as const,
  /** The Overview's server-side aggregate over one time range. */
  requestOverview: (range: OverviewRange) => ['request-overview', range] as const,
  backgroundJobs: () => ['background-jobs'] as const,
  audit: (filters: AuditQuery = {}) => ['audit', filters] as const,
  /**
   * Every page of the audit feed, whatever filters it carries. This is the key a
   * mutation invalidates: any write appends an entry the open page may show, and
   * the mutation has no idea which filters that page is holding.
   */
  auditAll: () => ['audit'] as const,
  usage: (providerId: string) => ['usage', providerId] as const,
}

/**
 * The keys that opt out of refetch-on-focus. Request history, the audit feed,
 * usage readings, and the Overview's aggregate are expensive historical reads;
 * re-pulling them every time the Owner returns to the tab would make Iroha
 * chattier than it is today for information that has not moved. The Overview's
 * aggregate is the most expensive of the four — a seven-day range buckets and
 * percentiles the whole `request_events` table — so it belongs here even though
 * it is one row rather than a page.
 *
 * `['background-jobs']` is deliberately absent: a job's status is live
 * operational state, and returning to the tab to find a sync still shown as
 * running is exactly the case focus refetch exists for.
 *
 * `query-client` applies this so a later screen cannot forget to.
 */
export const FOCUS_EXEMPT_KEY_PREFIXES: readonly string[] = [
  'requests',
  'audit',
  'usage',
  'request-overview',
]
