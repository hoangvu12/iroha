import { createApp } from '../../src/http/app.ts'
import { ReadinessState } from '../../src/http/readiness.ts'
import { OwnerIdentity, type PasswordHasher } from '../../src/identity/index.ts'
import type { Database } from '../../src/persistence/index.ts'
import { sqliteEngine } from '../persistence/engines.ts'
import { testClock, testPasswordHasher, type TestClock } from './identity.ts'

export const ORIGIN = 'http://iroha.test'

export interface TestApp {
  readonly app: ReturnType<typeof createApp>
  readonly database: Database
  readonly identity: OwnerIdentity
  readonly clock: TestClock
  /** Sends a request the way a same-origin browser would. */
  fetch(path: string, init?: RequestInit & { csrf?: string }): Promise<Response>
  dispose(): Promise<void>
}

export interface TestAppOptions {
  readonly setupToken?: string | undefined
  readonly recoveryToken?: string | undefined
  readonly sessionIdleSeconds?: number
  /** Replaces the cheap test hasher, for tests that watch how it is used. */
  readonly passwordHasher?: PasswordHasher
}

export const SETUP_TOKEN = 'setup-token-for-tests-0123456789abcdef'
export const RECOVERY_TOKEN = 'recovery-token-for-tests-0123456789abcd'

/**
 * The seam the spec names: the assembled application driven through its Web
 * `fetch` interface, over a real database, with only time and password cost
 * replaced.
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const { database, dispose } = await sqliteEngine.open()
  const clock = testClock()

  const identity = new OwnerIdentity({
    database,
    setupToken: 'setupToken' in options ? options.setupToken : SETUP_TOKEN,
    recoveryToken: options.recoveryToken,
    clock,
    passwordHasher: options.passwordHasher ?? testPasswordHasher,
    ...(options.sessionIdleSeconds === undefined
      ? {}
      : { sessionIdleSeconds: options.sessionIdleSeconds }),
  })

  // Elysia cannot report a caller address for a request handled without a
  // server, so every test request shares the throttle's unknown source.

  const readiness = new ReadinessState()
  readiness.markMigrated()
  const app = createApp({ database, readiness, identity })

  const cookies = new Map<string, string>()

  return {
    app,
    database,
    identity,
    clock,

    async fetch(path, init = {}) {
      const { csrf, headers, ...rest } = init
      const request = new Request(`${ORIGIN}${path}`, {
        ...rest,
        headers: {
          origin: ORIGIN,
          'user-agent': 'Test Browser',
          ...(cookies.size > 0
            ? { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') }
            : {}),
          ...(csrf === undefined ? {} : { 'x-iroha-csrf': csrf }),
          ...((headers as Record<string, string>) ?? {}),
        },
      })

      const response = await app.handle(request)
      rememberCookies(cookies, response)
      return response
    },

    dispose,
  }
}

/** A minimal cookie jar: enough to behave like the browser for these flows. */
function rememberCookies(jar: Map<string, string>, response: Response): void {
  for (const header of response.headers.getSetCookie()) {
    const [pair = '', ...attributes] = header.split(';')
    const separator = pair.indexOf('=')
    if (separator < 0) continue

    const name = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1).trim()
    const expired = attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute))

    if (expired || value === '') jar.delete(name)
    else jar.set(name, value)
  }
}

/** The stable error code a management response reported. */
export async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: unknown } }
  return typeof body.error?.code === 'string' ? body.error.code : '(no error code)'
}

export interface AuthenticationStateBody {
  readonly setupRequired: boolean
  readonly authenticated: boolean
  readonly recoveryEnabled: boolean
  readonly owner: { username: string } | null
  readonly session: { id: string; csrfToken: string } | null
}

export async function authState(test: TestApp): Promise<AuthenticationStateBody> {
  const response = await test.fetch('/api/v1/auth/state')
  return (await response.json()) as AuthenticationStateBody
}

export interface SignedIn {
  readonly csrf: string
  readonly sessionId: string
}

/** Completes first-run setup and returns what a signed-in browser holds. */
export async function completeSetup(
  test: TestApp,
  credentials: { username?: string; password?: string; setupToken?: string } = {},
): Promise<SignedIn> {
  const response = await test.fetch('/api/v1/auth/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: credentials.username ?? 'owner',
      password: credentials.password ?? 'correct horse battery staple',
      setupToken: credentials.setupToken ?? SETUP_TOKEN,
    }),
  })

  if (response.status !== 201) {
    throw new Error(`Setup failed with ${response.status}: ${await response.text()}`)
  }

  return heldSession(await response.json())
}

export async function signIn(
  test: TestApp,
  credentials: { username?: string; password?: string } = {},
): Promise<SignedIn> {
  const response = await test.fetch('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: credentials.username ?? 'owner',
      password: credentials.password ?? 'correct horse battery staple',
    }),
  })

  if (response.status !== 200) {
    throw new Error(`Login failed with ${response.status}: ${await response.text()}`)
  }

  return heldSession(await response.json())
}

function heldSession(body: unknown): SignedIn {
  const session = (body as AuthenticationStateBody).session
  if (session === null) throw new Error('The response carried no session')
  return { csrf: session.csrfToken, sessionId: session.id }
}
