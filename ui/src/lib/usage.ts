import { request } from './api-client.ts'

export interface UsageScope {
  readonly kind: 'key' | 'account' | 'connection_model' | 'provider' | 'unknown'
  readonly keyId?: string
  readonly accountId?: string
  readonly model?: string
}

export interface UsageReadingView {
  readonly unit: string
  readonly balance: number | null
  readonly used: number | null
  readonly limit: number | null
  readonly remainingPercent: number | null
  readonly plan: string | null
  readonly resetAt: string | null
  readonly scope: UsageScope
  /**
   * The Upstream Key the service used to fetch this reading, or `null` for a
   * reading that isn't tied to a specific key (legacy data, a reading the
   * service couldn't attribute to a key). The cell for a key in the Upstream
   * Keys table shows readings whose `keyId` matches the row's key, plus any
   * with `keyId: null`.
   */
  readonly keyId: string | null
  readonly confidence: 'confirmed' | 'unknown'
  readonly diagnostics: Readonly<Record<string, unknown>>
}

export interface UsageView {
  readonly visibility: 'reactive_only' | 'authoritative'
  /** Every successful reading since the last refresh; empty when nothing has succeeded. */
  readonly readings: readonly UsageReadingView[]
  readonly syncedAt: string | null
  readonly lastSuccessAt: string | null
  readonly lastFailureAt: string | null
  readonly lastFailureCode: string | null
  readonly lastFailureMessage: string | null
  readonly stale: boolean
  readonly nextPollAllowedAt: string | null
  readonly recovery: {
    readonly authoritative: boolean
    readonly hasCapacity: boolean
    readonly scope: UsageScope
    readonly takenAt: string
  } | null
}

export async function fetchUsage(
  providerId: string,
  signal?: AbortSignal,
): Promise<UsageView> {
  return await request<UsageView>(
    'GET',
    `/providers/${encodeURIComponent(providerId)}/usage`,
    { signal },
  )
}

export async function refreshUsage(
  providerId: string,
  csrfToken: string,
): Promise<UsageView> {
  return await request<UsageView>(
    'POST',
    `/providers/${encodeURIComponent(providerId)}/usage/refresh`,
    { csrfToken },
  )
}