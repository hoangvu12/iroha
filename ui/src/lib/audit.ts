export interface AuditEventView {
  readonly id: number
  readonly occurredAt: string
  readonly action: string
  readonly outcome: 'success' | 'failure'
  readonly detail: unknown
}

export interface AuditEventList {
  readonly events: readonly AuditEventView[]
  readonly total: number
}

export interface AuditFilter {
  readonly actionPrefix?: string
  readonly outcome?: 'success' | 'failure'
}

export class AuditError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'AuditError'
    this.code = code
  }
}

export async function fetchAudit(
  filter: AuditFilter = {},
  options: { limit?: number; offset?: number; signal?: AbortSignal } = {},
): Promise<AuditEventList> {
  const query = new URLSearchParams()
  if (filter.actionPrefix !== undefined && filter.actionPrefix !== '') {
    query.set('actionPrefix', filter.actionPrefix)
  }
  if (filter.outcome !== undefined) {
    query.set('outcome', filter.outcome)
  }
  if (options.limit !== undefined) query.set('limit', String(options.limit))
  if (options.offset !== undefined) query.set('offset', String(options.offset))
  const path = `/audit/${query.toString() === '' ? '' : `?${query.toString()}`}`
  return await request<AuditEventList>('GET', path, { signal: options.signal })
}

export async function clearAudit(csrfToken: string): Promise<number> {
  const body = await request<{ removed: number }>('DELETE', '/audit', { csrfToken })
  return body.removed
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
    throw new AuditError('unreachable', 'Iroha did not answer. Check that the gateway is running.')
  }

  if (response.status === 204) return undefined as T

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) throw toError(payload)
  return payload as T
}

function toError(payload: unknown): AuditError {
  const error = (payload as { error?: { code?: unknown; message?: unknown } })?.error
  return new AuditError(
    typeof error?.code === 'string' ? error.code : 'request_failed',
    typeof error?.message === 'string' ? error.message : 'That request could not be completed.',
  )
}