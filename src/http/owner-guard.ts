import {
  secretsMatch,
  type AuthenticatedSession,
  type OwnerIdentity,
} from '../identity/index.ts'

/** The Owner's session cookie. Its value is `<session id>.<secret>`. */
export const SESSION_COOKIE = 'iroha_session'

/** The header carrying the session's CSRF token on state-changing requests. */
export const CSRF_HEADER = 'x-iroha-csrf'

/**
 * Management errors use a small stable envelope. The OpenAI-shaped error body
 * belongs to the inference surface, which later tickets add.
 */
export interface ManagementError {
  readonly error: {
    readonly code: string
    readonly message: string
    readonly problems?: readonly { readonly field: string; readonly message: string }[]
  }
}

export interface GuardResponse {
  readonly response: { readonly status: 401 | 403; readonly body: ManagementError }
}

export type GuardOutcome = { readonly authenticated: AuthenticatedSession } | GuardResponse

export type CookieJar = Record<string, { set(config: Record<string, unknown>): unknown } | undefined>

export interface OwnerGuard {
  /** The live session behind a request, or null; renews the cookie when the idle expiry moved. */
  resolveSession(request: Request, cookie: CookieJar): Promise<AuthenticatedSession | null>
  /** The rule every Owner-only route shares: same origin, live session, CSRF for mutations. */
  requireOwner(
    context: { request: Request; cookie: CookieJar },
    options: { csrf: boolean },
  ): Promise<GuardOutcome>
}

export function createOwnerGuard(identity: OwnerIdentity): OwnerGuard {
  /**
   * Resolves the session and, when its idle expiry moved, reissues the cookie
   * so the browser's copy expires no sooner than the stored one. Without this
   * a browser in daily use would still be signed out on the seventh day.
   */
  const resolveSession = async (
    request: Request,
    cookie: CookieJar,
  ): Promise<AuthenticatedSession | null> => {
    const cookieValue = readCookie(request, SESSION_COOKIE)
    const authenticated = await identity.authenticate(cookieValue)

    if (authenticated?.renewed && cookieValue !== undefined) {
      setSessionCookie(cookie, request, cookieValue, identity.sessionIdleSeconds)
    }

    return authenticated
  }

  const requireOwner = async (
    context: { request: Request; cookie: CookieJar },
    options: { csrf: boolean },
  ): Promise<GuardOutcome> => {
    const crossOrigin = requireSameOrigin(context.request)
    if (crossOrigin !== null) return { response: { status: 403, body: crossOrigin } }

    const authenticated = await resolveSession(context.request, context.cookie)
    if (authenticated === null) {
      return {
        response: { status: 401, body: managementError('authentication_required', 'Sign in to continue.') },
      }
    }

    if (options.csrf) {
      const supplied = context.request.headers.get(CSRF_HEADER) ?? ''
      if (!secretsMatch(authenticated.session.csrfToken, supplied)) {
        return {
          response: {
            status: 403,
            body: managementError('csrf_token_invalid', 'This request is missing its session token.'),
          },
        }
      }
    }

    return { authenticated }
  }

  return { resolveSession, requireOwner }
}

export function managementError(code: string, message: string): ManagementError {
  return { error: { code, message } }
}

/**
 * Management traffic is same-origin only. A browser always sends `Origin` on a
 * state-changing request, so a mismatch is a cross-site attempt rather than an
 * ordinary client.
 */
export function requireSameOrigin(request: Request): ManagementError | null {
  const origin = request.headers.get('origin')
  if (origin === null) return null

  // `Host` is what the browser was told to reach; the request URL carries the
  // same authority when a runtime supplies it instead of a header.
  const host = request.headers.get('host') ?? new URL(request.url).host

  try {
    if (new URL(origin).host === host) return null
  } catch {
    // An unparseable Origin is not a same-origin request.
  }

  return managementError('cross_origin_denied', 'Management requests must be same-origin.')
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie')
  if (header === null) return undefined

  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    if (part.slice(0, separator).trim() !== name) continue
    return decodeURIComponent(part.slice(separator + 1).trim())
  }

  return undefined
}

export function setSessionCookie(
  cookie: CookieJar,
  request: Request,
  value: string,
  maxAgeSeconds: number,
): void {
  cookie[SESSION_COOKIE]?.set({
    value,
    httpOnly: true,
    sameSite: 'strict',
    secure: isSecureRequest(request),
    path: '/',
    maxAge: maxAgeSeconds,
  })
}

export function clearSessionCookie(cookie: CookieJar, request: Request): void {
  // A browser only replaces a cookie when the path and security attributes
  // match the one it holds, so expiry repeats them rather than clearing alone.
  setSessionCookie(cookie, request, '', 0)
}

/**
 * Whether the browser reached Iroha over TLS, including through a terminating
 * proxy. Marking the cookie `Secure` on a plain-HTTP installation would make it
 * unusable, so the flag follows the connection rather than a fixed setting.
 *
 * Either signal alone is enough: a forwarded header can only ever add `Secure`,
 * so a client that sends a false one cannot strip the flag from a real TLS
 * connection.
 */
function isSecureRequest(request: Request): boolean {
  if (new URL(request.url).protocol === 'https:') return true

  const forwarded = request.headers.get('x-forwarded-proto')
  return forwarded !== null && forwarded.split(',')[0]?.trim() === 'https'
}
