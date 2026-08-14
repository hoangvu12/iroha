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

export class UsageError extends Error {
  readonly code: string
  readonly retryAfterSeconds: number | null

  constructor(code: string, message: string, retryAfterSeconds: number | null = null) {
    super(message)
    this.name = 'UsageError'
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
  }
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

async function request<T = unknown>(
  method: string,
  path: string,
  options: { body?: unknown; csrfToken?: string; signal?: AbortSignal } = {},
): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api/v1/admin${path}`, {
      method,
      credentials: 'same-origin',
      ...(options.signal ? { signal: options.signal } : {}),
      headers: {
        accept: 'application/json',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.csrfToken === undefined ? {} : { 'x-iroha-csrf': options.csrfToken }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
  } catch {
    throw new UsageError('unreachable', 'Iroha did not answer. Check that the gateway is running.')
  }

  if (response.status === 204) return undefined as T

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) throw toError(response, payload)
  return payload as T
}

function toError(response: Response, payload: unknown): UsageError {
  const error = (payload as { error?: { code?: unknown; message?: unknown } })?.error
  const retryAfter = Number(response.headers.get('retry-after'))
  const message =
    typeof error?.message === 'string' ? error.message : 'That request could not be completed.'
  return new UsageError(
    typeof error?.code === 'string' ? error.code : 'request_failed',
    message,
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
  )
}