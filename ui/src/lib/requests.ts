export interface RequestAttemptView {
  readonly id: number
  readonly attemptNumber: number
  readonly keyId: string | null
  readonly startedAt: string
  readonly completedAt: string | null
  readonly status: number | null
  readonly outcome: 'success' | 'failure' | 'skipped'
  readonly errorCode: string | null
  readonly retryAfterSeconds: number | null
}

export interface RequestEventView {
  readonly id: string
  readonly occurredAt: string
  readonly connectionId: string
  readonly model: string
  readonly gatewayKeyId: string | null
  readonly keyId: string | null
  readonly status: number
  readonly outcome: 'success' | 'failure'
  readonly latencyMs: number
  readonly isStreaming: boolean
  readonly promptTokens: number | null
  readonly completionTokens: number | null
  readonly totalTokens: number | null
  readonly errorCode: string | null
}

export interface RequestEventList {
  readonly events: readonly RequestEventView[]
  readonly total: number
}

export interface RequestEventDetail {
  readonly event: RequestEventView
  readonly attempts: readonly RequestAttemptView[]
}

export interface RequestFilter {
  readonly connectionId?: string
  readonly outcome?: 'success' | 'failure'
  readonly model?: string
  readonly keyId?: string
}

export interface FieldProblem {
  readonly field: string
  readonly message: string
}

export class RequestHistoryError extends Error {
  readonly code: string
  readonly problems: readonly FieldProblem[]

  constructor(code: string, message: string, problems: readonly FieldProblem[] = []) {
    super(message)
    this.name = 'RequestHistoryError'
    this.code = code
    this.problems = problems
  }
}

export async function fetchRequests(
  filter: RequestFilter = {},
  options: { limit?: number; offset?: number; signal?: AbortSignal } = {},
): Promise<RequestEventList> {
  const query = new URLSearchParams()
  if (filter.connectionId !== undefined && filter.connectionId !== '') {
    query.set('connectionId', filter.connectionId)
  }
  if (filter.outcome !== undefined) {
    query.set('outcome', filter.outcome)
  }
  if (filter.model !== undefined && filter.model !== '') {
    query.set('model', filter.model)
  }
  if (filter.keyId !== undefined && filter.keyId !== '') {
    query.set('keyId', filter.keyId)
  }
  if (options.limit !== undefined) {
    query.set('limit', String(options.limit))
  }
  if (options.offset !== undefined) {
    query.set('offset', String(options.offset))
  }
  const path = `/requests/${query.toString() === '' ? '' : `?${query.toString()}`}`
  return await request<RequestEventList>('GET', path, { signal: options.signal })
}

export async function fetchRequestDetail(
  id: string,
  signal?: AbortSignal,
): Promise<RequestEventDetail> {
  return await request<RequestEventDetail>('GET', `/requests/${encodeURIComponent(id)}`, { signal })
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
    throw new RequestHistoryError(
      'unreachable',
      'Iroha did not answer. Check that the gateway is running.',
    )
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

function toError(payload: unknown): RequestHistoryError {
  const error = (payload as { error?: { code?: unknown; message?: unknown; problems?: unknown } })
    ?.error
  return new RequestHistoryError(
    typeof error?.code === 'string' ? error.code : 'request_failed',
    typeof error?.message === 'string' ? error.message : 'That request could not be completed.',
    Array.isArray(error?.problems) ? (error.problems as FieldProblem[]) : [],
  )
}