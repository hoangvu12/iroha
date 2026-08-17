import type { AuditFilter } from './audit.ts'
import type { RequestFilter } from './requests.ts'

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
  audit: (filters: AuditQuery = {}) => ['audit', filters] as const,
  usage: (providerId: string) => ['usage', providerId] as const,
}

/**
 * The keys that opt out of refetch-on-focus. Request history, the audit feed,
 * and usage readings are expensive historical reads; re-pulling them every time
 * the Owner returns to the tab would make Iroha chattier than it is today for
 * information that has not moved. `query-client` applies this so a later screen
 * cannot forget to.
 */
export const FOCUS_EXEMPT_KEY_PREFIXES: readonly string[] = ['requests', 'audit', 'usage']
