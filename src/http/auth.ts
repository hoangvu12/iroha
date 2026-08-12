import { Elysia } from 'elysia'
import {
  secretsMatch,
  UNKNOWN_SOURCE,
  type AttemptSource,
  type AuthenticatedSession,
  type IdentityFailure,
  type IssuedSession,
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

/**
 * Everything the Owner's browser needs to know which screen to show. It is
 * readable without a session, so it contains no configuration values, and it
 * is the same shape whether it is read, or returned by signing in.
 */
export interface AuthenticationState {
  readonly setupRequired: boolean
  readonly authenticated: boolean
  /** Whether the recovery flow exists at all. Never the token itself. */
  readonly recoveryEnabled: boolean
  readonly owner: { readonly username: string } | null
  readonly session: { readonly id: string; readonly csrfToken: string } | null
}

export interface AuthRoutesOptions {
  readonly identity: OwnerIdentity
}

/**
 * The Owner's authentication surface.
 *
 * Cookies are read from the request header rather than through the cookie jar
 * so that the exact value Iroha validates is the exact value the browser sent,
 * and written through the jar so that several `Set-Cookie` headers compose.
 */
export function createAuthRoutes({ identity }: AuthRoutesOptions) {
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

  /**
   * The rule every Owner-only route shares: a same-origin request, a live
   * session, and — for anything that changes state — the session's CSRF token.
   */
  const requireOwner = async (
    context: { request: Request; cookie: CookieJar },
    options: { csrf: boolean },
  ): Promise<{ authenticated: AuthenticatedSession } | GuardResponse> => {
    const crossOrigin = requireSameOrigin(context.request)
    if (crossOrigin !== null) return { response: { status: 403, body: crossOrigin } }

    const authenticated = await resolveSession(context.request, context.cookie)
    if (authenticated === null) {
      return {
        response: { status: 401, body: error('authentication_required', 'Sign in to continue.') },
      }
    }

    if (options.csrf) {
      const supplied = context.request.headers.get(CSRF_HEADER) ?? ''
      if (!secretsMatch(authenticated.session.csrfToken, supplied)) {
        return {
          response: {
            status: 403,
            body: error('csrf_token_invalid', 'This request is missing its session token.'),
          },
        }
      }
    }

    return { authenticated }
  }

  const state = async (authenticated: AuthenticatedSession | IssuedSession | null) => {
    const owner = await identity.owner()
    const session = authenticated === null ? null : sessionOf(authenticated)

    return {
      setupRequired: owner === null,
      authenticated: session !== null,
      recoveryEnabled: identity.recoveryEnabled,
      owner: session !== null && owner !== null ? { username: owner.username } : null,
      session,
    } satisfies AuthenticationState
  }

  return new Elysia({ name: 'iroha/auth', prefix: '/api/v1/auth' })
    .onError({ as: 'scoped' }, ({ code, status }) => {
      // Elysia's own validation report quotes the offending value, which for
      // these routes could be a password. Nothing but a stable code leaves here.
      if (code === 'VALIDATION' || code === 'PARSE') {
        return status(400, error('invalid_request', 'The request body could not be read.'))
      }

      return undefined
    })
    .get(
      '/state',
      async ({ request, cookie }) => await state(await resolveSession(request, cookie)),
      {
        detail: {
          summary: 'Authentication state',
          description:
            'Reports whether first-run setup is still open, whether this browser is signed in, and whether recovery is configured. The Owner username is disclosed only to a signed-in browser.',
        },
      },
    )
    .post(
      '/setup',
      async ({ body, request, server, cookie, status }) => {
        const sameOrigin = requireSameOrigin(request)
        if (sameOrigin !== null) return status(403, sameOrigin)

        const input = asObject(body)
        const result = await identity.setup({
          username: input.username,
          password: input.password,
          setupToken: input.setupToken,
          userAgent: describeClient(request),
          source: sourceOf(server, request),
        })

        if (!result.ok) return respondToFailure(status, result.failure)

        setSessionCookie(cookie, request, result.value.cookieValue, identity.sessionIdleSeconds)
        return status(201, await state(result.value))
      },
      {
        detail: {
          summary: 'Claim the installation',
          description:
            'Creates the sole Owner using the configured setup token and signs the browser in. Once an Owner exists this route is permanently closed and cannot replace them.',
        },
      },
    )
    .post(
      '/login',
      async ({ body, request, server, cookie, status }) => {
        const sameOrigin = requireSameOrigin(request)
        if (sameOrigin !== null) return status(403, sameOrigin)

        const input = asObject(body)
        const result = await identity.login({
          username: input.username,
          password: input.password,
          userAgent: describeClient(request),
          source: sourceOf(server, request),
        })

        if (!result.ok) return respondToFailure(status, result.failure)

        setSessionCookie(cookie, request, result.value.cookieValue, identity.sessionIdleSeconds)
        return await state(result.value)
      },
      {
        detail: {
          summary: 'Sign in',
          description:
            'Exchanges the Owner username and password for a session cookie. Failures are reported identically whether the username, the password, or both were wrong.',
        },
      },
    )
    .post(
      '/logout',
      async ({ request, cookie, status }) => {
        const guard = await requireOwner({ request, cookie }, { csrf: true })
        if ('response' in guard) return status(guard.response.status, guard.response.body)

        await identity.revokeSession(guard.authenticated.session.id, 'logout')
        clearSessionCookie(cookie, request)
        return status(204, undefined)
      },
      {
        detail: {
          summary: 'Sign out',
          description: 'Revokes the session this browser is using and clears its cookie.',
        },
      },
    )
    .get(
      '/sessions',
      async ({ request, cookie, status }) => {
        const guard = await requireOwner({ request, cookie }, { csrf: false })
        if ('response' in guard) return status(guard.response.status, guard.response.body)

        return { sessions: await identity.sessions(guard.authenticated.session.id) }
      },
      {
        detail: {
          summary: 'List sessions',
          description:
            'Lists every live Owner session with the browser description it was created from. Session secrets are never listed.',
        },
      },
    )
    .delete(
      '/sessions',
      async ({ request, cookie, status }) => {
        const guard = await requireOwner({ request, cookie }, { csrf: true })
        if ('response' in guard) return status(guard.response.status, guard.response.body)

        const revoked = await identity.revokeAllSessions()
        clearSessionCookie(cookie, request)
        return { revoked }
      },
      {
        detail: {
          summary: 'Sign out everywhere',
          description: 'Revokes every Owner session, including the one making the request.',
        },
      },
    )
    .delete(
      '/sessions/:id',
      async ({ params, request, cookie, status }) => {
        const guard = await requireOwner({ request, cookie }, { csrf: true })
        if ('response' in guard) return status(guard.response.status, guard.response.body)

        const revoked = await identity.revokeSession(params.id, 'revoked')
        if (!revoked) {
          return status(404, error('session_not_found', 'That session is no longer signed in.'))
        }

        if (params.id === guard.authenticated.session.id) clearSessionCookie(cookie, request)
        return status(204, undefined)
      },
      {
        detail: {
          summary: 'Revoke a session',
          description:
            'Revokes one session by ID. Revoking the current session also clears this browser’s cookie.',
        },
      },
    )
    .post(
      '/recover',
      async ({ body, request, server, status }) => {
        const sameOrigin = requireSameOrigin(request)
        if (sameOrigin !== null) return status(403, sameOrigin)

        const input = asObject(body)
        const result = await identity.recover({
          recoveryToken: input.recoveryToken,
          password: input.password,
          source: sourceOf(server, request),
        })

        if (!result.ok) return respondToFailure(status, result.failure)

        // Recovery deliberately does not sign the browser in: the Owner proves
        // the new password immediately by logging in with it.
        return { sessionsRevoked: result.value.sessionsRevoked }
      },
      {
        detail: {
          summary: 'Recover access',
          description:
            'Sets a new Owner password using the configured recovery token and revokes every existing session. Attempts are throttled and audited.',
        },
      },
    )
}

export type AuthRoutes = ReturnType<typeof createAuthRoutes>

interface GuardResponse {
  readonly response: { readonly status: 401 | 403; readonly body: ManagementError }
}

function sessionOf(
  authenticated: AuthenticatedSession | IssuedSession,
): { id: string; csrfToken: string } {
  return 'session' in authenticated
    ? { id: authenticated.session.id, csrfToken: authenticated.session.csrfToken }
    : { id: authenticated.sessionId, csrfToken: authenticated.csrfToken }
}

/**
 * Management traffic is same-origin only. A browser always sends `Origin` on a
 * state-changing request, so a mismatch is a cross-site attempt rather than an
 * ordinary client.
 */
function requireSameOrigin(request: Request): ManagementError | null {
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

  return error('cross_origin_denied', 'Management requests must be same-origin.')
}

function respondToFailure(
  status: (code: number, body: unknown) => unknown,
  failure: IdentityFailure,
) {
  switch (failure.code) {
    case 'setup_closed':
      return status(
        409,
        error('setup_closed', 'This installation already has an Owner. Sign in instead.'),
      )
    case 'setup_token_invalid':
      return status(403, error('setup_token_invalid', 'The setup token is not correct.'))
    case 'invalid_credentials':
      return status(401, error('invalid_credentials', 'That username and password do not match.'))
    case 'recovery_unavailable':
      return status(
        403,
        error('recovery_unavailable', 'Recovery is unavailable or the token is not correct.'),
      )
    case 'validation_failed':
      return status(400, {
        error: {
          code: 'validation_failed',
          message: 'The submitted values are not acceptable.',
          problems: failure.problems,
        },
      } satisfies ManagementError)
    case 'too_many_attempts':
      return Response.json(
        error('too_many_attempts', 'Too many attempts. Wait before trying again.'),
        { status: 429, headers: { 'retry-after': String(failure.retryAfterSeconds) } },
      )
  }
}

function error(code: string, message: string): ManagementError {
  return { error: { code, message } }
}

type CookieJar = Record<string, { set(config: Record<string, unknown>): unknown } | undefined>

function setSessionCookie(
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

function clearSessionCookie(cookie: CookieJar, request: Request): void {
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

/**
 * Who is calling, for the failure throttle. Behind a reverse proxy every caller
 * looks like the proxy, which is the same behaviour as one shared counter;
 * `X-Forwarded-For` is not trusted, because anyone could send it and thereby
 * buy themselves an unlimited number of attempts.
 */
function sourceOf(server: AddressLookup | null, request: Request): AttemptSource {
  return server?.requestIP(request)?.address ?? UNKNOWN_SOURCE
}

/**
 * The part of the running server this file needs. Described structurally so
 * that HTTP routing does not depend on a runtime type, and so that a test
 * handling a request without a server simply has none.
 */
interface AddressLookup {
  requestIP(request: Request): { address: string } | null
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

/** A short, non-identifying description of the client for the session list. */
function describeClient(request: Request): string | null {
  const userAgent = request.headers.get('user-agent')
  if (userAgent === null) return null
  return userAgent.slice(0, 200)
}

function asObject(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
}
