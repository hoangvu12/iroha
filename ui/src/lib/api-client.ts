/**
 * The one way the management UI talks to Iroha. Every module under `lib/` used
 * to carry its own copy of this fetch wrapper and its own error class named
 * after the area it served, which meant nine places to fix a header, nine
 * `instanceof` checks that could not see each other's failures, and nine
 * spellings of the same 401.
 */

export interface FieldProblem {
  readonly field: string
  readonly message: string
}

/**
 * A failed management request, carrying the stable code the API returned so a
 * screen can react to a specific rule rather than to message text.
 */
export class ApiError extends Error {
  readonly code: string
  readonly problems: readonly FieldProblem[]
  /**
   * How long the API asked the caller to wait, from `retry-after`. Sign-in
   * throttling and the usage refresh cooldown both report their wait this way;
   * every other failure leaves it null.
   */
  readonly retryAfterSeconds: number | null

  constructor(
    code: string,
    message: string,
    problems: readonly FieldProblem[] = [],
    retryAfterSeconds: number | null = null,
  ) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.problems = problems
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/** Whatever failed, as an `ApiError`. A rejection from outside `request` is opaque. */
export function toApiError(cause: unknown): ApiError {
  return cause instanceof ApiError
    ? cause
    : new ApiError('request_failed', 'That request could not be completed.')
}

/** The Owner-only routes: Providers, Gateway Keys, history, settings, jobs. */
export const ADMIN_BASE = '/api/v1/admin'

/** Setup, sign-in, sign-out, and Owner Session management. */
export const AUTH_BASE = '/api/v1/auth'

export interface RequestOptions {
  readonly body?: unknown
  readonly csrfToken?: string
  readonly signal?: AbortSignal
  /** Defaults to the Owner-only routes; only the auth surface needs the other. */
  readonly base?: string
}

export async function request<T = unknown>(
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  let response: Response

  try {
    response = await fetch(`${options.base ?? ADMIN_BASE}${path}`, {
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
    throw new ApiError('unreachable', 'Iroha did not answer. Check that the gateway is running.')
  }

  if (response.status === 204) return undefined as T

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (response.ok) return payload as T

  const failure = toError(response, payload)
  signOutIfSessionEnded(failure)
  throw failure
}

function toError(response: Response, payload: unknown): ApiError {
  const error = (payload as { error?: { code?: unknown; message?: unknown; problems?: unknown } })
    ?.error

  const retryAfter = Number(response.headers.get('retry-after'))

  return new ApiError(
    typeof error?.code === 'string' ? error.code : 'request_failed',
    typeof error?.message === 'string' ? error.message : 'That request could not be completed.',
    Array.isArray(error?.problems) ? (error.problems as FieldProblem[]) : [],
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
  )
}

let ownerSignOut: (() => void) | null = null
let signOutRequested = false

/**
 * Signing the Owner out means clearing React state and navigating, which only
 * the component tree can do — but the code that notices the session is gone
 * runs at module scope, in `request` and in the query caches' shared `onError`.
 * `App` registers its handler here on mount; this subscriber is the seam
 * between the two.
 */
export function registerOwnerSignOut(handler: () => void): () => void {
  ownerSignOut = handler
  // A fresh registration is a fresh Owner Session, so the latch reopens.
  signOutRequested = false

  return () => {
    if (ownerSignOut === handler) ownerSignOut = null
  }
}

/**
 * Signs the Owner out when a failure means the Owner Session is gone. Only the
 * Owner guard emits `authentication_required`, so the code is unambiguous: no
 * setup, sign-in, or state read can produce it.
 *
 * The latch collapses the several 401s a screen with concurrent reads in flight
 * produces into one sign-out.
 */
export function signOutIfSessionEnded(cause: unknown): void {
  if (!(cause instanceof ApiError) || cause.code !== 'authentication_required') return
  if (signOutRequested || ownerSignOut === null) return

  signOutRequested = true
  ownerSignOut()
}
