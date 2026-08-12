export interface AuthState {
  readonly setupRequired: boolean
  readonly authenticated: boolean
  readonly recoveryEnabled: boolean
  readonly owner: { readonly username: string } | null
  readonly session: { readonly id: string; readonly csrfToken: string } | null
}

export interface SessionSummary {
  readonly id: string
  readonly current: boolean
  readonly createdAt: string
  readonly lastSeenAt: string
  readonly expiresAt: string
  readonly userAgent: string | null
}

export interface FieldProblem {
  readonly field: string
  readonly message: string
}

/**
 * A failed management request, carrying the stable code the API returned so a
 * screen can react to a specific rule rather than to message text.
 */
export class AuthError extends Error {
  readonly code: string
  readonly problems: readonly FieldProblem[]
  readonly retryAfterSeconds: number | null

  constructor(
    code: string,
    message: string,
    problems: readonly FieldProblem[] = [],
    retryAfterSeconds: number | null = null,
  ) {
    super(message)
    this.name = 'AuthError'
    this.code = code
    this.problems = problems
    this.retryAfterSeconds = retryAfterSeconds
  }
}

const BASE = '/api/v1/auth'

export async function fetchAuthState(signal?: AbortSignal): Promise<AuthState> {
  return await request<AuthState>('GET', '/state', { signal })
}

export async function setupOwner(input: {
  username: string
  password: string
  setupToken: string
}): Promise<AuthState> {
  // Setup and sign-in answer with the same state the screen would otherwise
  // have to fetch, so signing in costs one round trip.
  return await request<AuthState>('POST', '/setup', { body: input })
}

export async function signIn(input: { username: string; password: string }): Promise<AuthState> {
  return await request<AuthState>('POST', '/login', { body: input })
}

export async function signOut(csrfToken: string): Promise<void> {
  await request('POST', '/logout', { csrfToken })
}

export async function fetchSessions(): Promise<readonly SessionSummary[]> {
  const body = await request<{ sessions: readonly SessionSummary[] }>('GET', '/sessions')
  return body.sessions
}

export async function revokeSession(id: string, csrfToken: string): Promise<void> {
  await request('DELETE', `/sessions/${encodeURIComponent(id)}`, { csrfToken })
}

export async function revokeAllSessions(csrfToken: string): Promise<number> {
  const body = await request<{ revoked: number }>('DELETE', '/sessions', { csrfToken })
  return body.revoked
}

export async function recoverAccess(input: {
  recoveryToken: string
  password: string
}): Promise<number> {
  const body = await request<{ sessionsRevoked: number }>('POST', '/recover', { body: input })
  return body.sessionsRevoked
}

async function request<T = unknown>(
  method: string,
  path: string,
  options: { body?: unknown; csrfToken?: string; signal?: AbortSignal } = {},
): Promise<T> {
  let response: Response

  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      // Same-origin credentials only: the management API refuses anything else.
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
    throw new AuthError('unreachable', 'Iroha did not answer. Check that the gateway is running.')
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

function toError(response: Response, payload: unknown): AuthError {
  const error = (payload as { error?: { code?: unknown; message?: unknown; problems?: unknown } })
    ?.error

  const retryAfter = Number(response.headers.get('retry-after'))

  return new AuthError(
    typeof error?.code === 'string' ? error.code : 'request_failed',
    typeof error?.message === 'string' ? error.message : 'That request could not be completed.',
    Array.isArray(error?.problems) ? (error.problems as FieldProblem[]) : [],
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
  )
}
