import type { Database, Repositories, SessionRecord } from '../persistence/index.ts'
import { systemClock, type Clock } from '../runtime/clock.ts'
import { checkCredentials, checkPassword, type CredentialProblem } from './credentials.ts'
import { argon2idPasswordHasher, type PasswordHasher } from './passwords.ts'
import { hashSecret, randomSecret, secretsMatch } from './secrets.ts'
import {
  createAttemptThrottle,
  UNKNOWN_SOURCE,
  type AttemptSource,
  type AttemptThrottle,
} from './throttle.ts'

/** How long a session survives without being used. Each use slides it forward. */
export const SESSION_IDLE_SECONDS = 7 * 24 * 60 * 60

/**
 * The shortest gap between two renewals of the same session. Without it every
 * request would write to the session row purely to move the clock forward.
 */
const SESSION_TOUCH_SECONDS = 60

/**
 * Failure budgets per source. They are deliberately modest rather than harsh:
 * the real brake on guessing is Argon2id's cost, and a long refusal would be
 * worth more to someone trying to lock the Owner out than to the Owner.
 */
const DEFAULT_LIMITS = {
  setup: { attempts: 10, windowSeconds: 15 * 60 },
  login: { attempts: 10, windowSeconds: 5 * 60 },
  recovery: { attempts: 5, windowSeconds: 15 * 60 },
} as const

export type ThrottledAction = keyof typeof DEFAULT_LIMITS

export type IdentityFailure =
  /** An Owner already exists; setup can never replace them. */
  | { readonly code: 'setup_closed' }
  /** The setup token was wrong, or none is configured. The two are not distinguished. */
  | { readonly code: 'setup_token_invalid' }
  /** Recovery is not configured, the token was wrong, or there is no Owner yet. */
  | { readonly code: 'recovery_unavailable' }
  | { readonly code: 'invalid_credentials' }
  | { readonly code: 'validation_failed'; readonly problems: readonly CredentialProblem[] }
  | { readonly code: 'too_many_attempts'; readonly retryAfterSeconds: number }

export type IdentityResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: IdentityFailure }

/** A session as the browser must hold it: the cookie value exists only here. */
export interface IssuedSession {
  readonly cookieValue: string
  readonly csrfToken: string
  readonly expiresAt: Date
  readonly sessionId: string
}

export interface AuthenticatedSession {
  readonly session: SessionRecord
  /** True when the idle expiry moved, so the cookie's lifetime should be reissued. */
  readonly renewed: boolean
}

/** What the Owner may see about their own account. Never includes the password hash. */
export interface OwnerSummary {
  readonly username: string
  readonly createdAt: Date
  readonly passwordChangedAt: Date
}

export interface SessionSummary {
  readonly id: string
  readonly current: boolean
  readonly createdAt: Date
  readonly lastSeenAt: Date
  readonly expiresAt: Date
  readonly userAgent: string | null
}

export interface OwnerIdentityOptions {
  readonly database: Database
  /** Authorizes first-run setup. Absent means setup cannot succeed. */
  readonly setupToken?: string | undefined
  /** Absent means browser-based recovery is switched off. */
  readonly recoveryToken?: string | undefined
  readonly clock?: Clock
  readonly passwordHasher?: PasswordHasher
  readonly sessionIdleSeconds?: number
}

/**
 * Everything Iroha knows about being signed in as the Owner.
 *
 * The rules that matter live here rather than in the HTTP layer: setup closes
 * permanently, failures stay indistinguishable to a caller, sessions are
 * validated against a stored hash, and recovery revokes what it invalidates.
 */
export class OwnerIdentity {
  readonly #database: Database
  readonly #setupToken: string | undefined
  readonly #recoveryToken: string | undefined
  readonly #clock: Clock
  readonly #hasher: PasswordHasher
  readonly #idleSeconds: number
  readonly #throttle: AttemptThrottle<ThrottledAction>

  constructor(options: OwnerIdentityOptions) {
    this.#database = options.database
    this.#setupToken = options.setupToken
    this.#recoveryToken = options.recoveryToken
    this.#clock = options.clock ?? systemClock
    this.#hasher = options.passwordHasher ?? argon2idPasswordHasher
    this.#idleSeconds = options.sessionIdleSeconds ?? SESSION_IDLE_SECONDS
    this.#throttle = createAttemptThrottle(DEFAULT_LIMITS, this.#clock)
  }

  get sessionIdleSeconds(): number {
    return this.#idleSeconds
  }

  /** Whether browser-based recovery is configured. The token itself is never exposed. */
  get recoveryEnabled(): boolean {
    return this.#recoveryToken !== undefined
  }

  async ownerExists(): Promise<boolean> {
    return (await this.#database.owner.get()) !== null
  }

  async owner(): Promise<OwnerSummary | null> {
    const owner = await this.#database.owner.get()
    if (owner === null) return null

    return {
      username: owner.username,
      createdAt: owner.createdAt,
      passwordChangedAt: owner.passwordChangedAt,
    }
  }

  /**
   * Claims the installation. Succeeds at most once in the lifetime of a
   * database: the second attempt is refused by the Owner table's primary key,
   * not by a check that two requests could race past.
   */
  async setup(input: {
    username: unknown
    password: unknown
    setupToken: unknown
    userAgent?: string | null
    source?: AttemptSource
  }): Promise<IdentityResult<IssuedSession>> {
    const source = input.source ?? UNKNOWN_SOURCE
    const allowed = this.#throttle.check('setup', source)
    if (!allowed.allowed) {
      return failed({ code: 'too_many_attempts', retryAfterSeconds: allowed.retryAfterSeconds })
    }

    // Setup being closed is not a secret — it is visible in the public state —
    // so it is reported before the token is examined.
    if (await this.ownerExists()) return failed({ code: 'setup_closed' })

    if (!this.#tokenMatches(this.#setupToken, input.setupToken)) {
      this.#throttle.recordFailure('setup', source)
      await this.#audit('owner.setup', 'failure', { reason: 'setup_token_invalid' })
      return failed({ code: 'setup_token_invalid' })
    }

    const credentials = checkCredentials(input)
    if (!credentials.ok) {
      return failed({ code: 'validation_failed', problems: credentials.problems })
    }

    const passwordHash = await this.#hasher.hash(credentials.value.password)
    const at = this.#clock.now()

    const issued = await this.#database.transaction(async (repositories) => {
      const created = await repositories.owner.create({
        username: credentials.value.username,
        passwordHash,
        at,
      })
      if (created === null) return null

      await repositories.audit.record({
        action: 'owner.setup',
        outcome: 'success',
        detail: { username: created.username },
        at,
      })

      return await this.#issueSession(repositories, input.userAgent ?? null, at)
    })

    if (issued === null) return failed({ code: 'setup_closed' })

    this.#throttle.recordSuccess('setup', source)
    return { ok: true, value: issued }
  }

  async login(input: {
    username: unknown
    password: unknown
    userAgent?: string | null
    source?: AttemptSource
  }): Promise<IdentityResult<IssuedSession>> {
    const source = input.source ?? UNKNOWN_SOURCE
    const allowed = this.#throttle.check('login', source)
    if (!allowed.allowed) {
      return failed({ code: 'too_many_attempts', retryAfterSeconds: allowed.retryAfterSeconds })
    }

    const owner = await this.#database.owner.get()
    const username = typeof input.username === 'string' ? input.username.trim() : ''
    const password = typeof input.password === 'string' ? input.password : ''

    // The password is always verified, even against a username that cannot
    // match and on an installation with no Owner, so that how long a rejection
    // takes says nothing about which half of the credentials was wrong.
    const passwordCorrect = await this.#hasher.verify(
      password,
      owner?.passwordHash ?? (await this.#unmatchableHash()),
    )

    if (owner === null || username !== owner.username || !passwordCorrect) {
      this.#throttle.recordFailure('login', source)
      // The attempted values are deliberately absent: a mistyped password
      // belongs in no record Iroha keeps.
      await this.#audit('owner.login', 'failure', { reason: 'invalid_credentials' })
      return failed({ code: 'invalid_credentials' })
    }

    const at = this.#clock.now()
    await this.#database.sessions.removeExpired(at)

    const issued = await this.#database.transaction(async (repositories) => {
      const session = await this.#issueSession(repositories, input.userAgent ?? null, at)
      await repositories.audit.record({ action: 'owner.login', outcome: 'success', at })
      return session
    })

    this.#throttle.recordSuccess('login', source)
    return { ok: true, value: issued }
  }

  /**
   * Resolves a session cookie, sliding its expiry when it is used.
   *
   * Returns `null` for anything that is not a live session, so a caller cannot
   * tell an expired session from a forged one.
   */
  async authenticate(cookieValue: string | undefined | null): Promise<AuthenticatedSession | null> {
    if (!cookieValue) return null

    const separator = cookieValue.indexOf('.')
    if (separator <= 0) return null

    const id = cookieValue.slice(0, separator)
    const secret = cookieValue.slice(separator + 1)

    const session = await this.#database.sessions.get(id)
    if (session === null) return null

    const now = this.#clock.now()
    if (session.expiresAt.getTime() <= now.getTime()) {
      await this.#database.sessions.remove(id)
      return null
    }

    if (!secretsMatch(session.secretHash, hashSecret(secret))) return null

    if (now.getTime() - session.lastSeenAt.getTime() < SESSION_TOUCH_SECONDS * 1000) {
      return { session, renewed: false }
    }

    const expiresAt = this.#expiry(now)
    const stillPresent = await this.#database.sessions.touch(id, now, expiresAt)
    if (!stillPresent) return null

    return { session: { ...session, lastSeenAt: now, expiresAt }, renewed: true }
  }

  async sessions(currentSessionId: string): Promise<readonly SessionSummary[]> {
    await this.#database.sessions.removeExpired(this.#clock.now())
    const sessions = await this.#database.sessions.list()

    return sessions.map((session) => ({
      id: session.id,
      current: session.id === currentSessionId,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
      userAgent: session.userAgent,
    }))
  }

  /** Ends one session. Used both for logout and for revoking another device. */
  async revokeSession(id: string, reason: 'logout' | 'revoked'): Promise<boolean> {
    const removed = await this.#database.sessions.remove(id)
    if (!removed) return false

    await this.#audit(reason === 'logout' ? 'owner.logout' : 'owner.session_revoked', 'success', {
      sessionId: id,
    })
    return true
  }

  /** Ends every session, including the one making the request. */
  async revokeAllSessions(): Promise<number> {
    const revoked = await this.#database.sessions.removeAll()
    await this.#audit('owner.sessions_revoked', 'success', { revoked })
    return revoked
  }

  /**
   * Resets the password using the environment recovery token, then revokes
   * every session so that a session opened before the reset cannot survive it.
   */
  async recover(input: {
    recoveryToken: unknown
    password: unknown
    source?: AttemptSource
  }): Promise<IdentityResult<{ sessionsRevoked: number }>> {
    const source = input.source ?? UNKNOWN_SOURCE
    const allowed = this.#throttle.check('recovery', source)
    if (!allowed.allowed) {
      return failed({ code: 'too_many_attempts', retryAfterSeconds: allowed.retryAfterSeconds })
    }

    // The new password is the caller's own input, so checking it first keeps a
    // validation message from confirming that the recovery token was correct.
    const password = checkPassword(input.password)
    if (!password.ok) {
      return failed({ code: 'validation_failed', problems: password.problems })
    }

    const owner = await this.#database.owner.get()
    if (owner === null || !this.#tokenMatches(this.#recoveryToken, input.recoveryToken)) {
      this.#throttle.recordFailure('recovery', source)
      await this.#audit('owner.recovery', 'failure', { reason: 'recovery_unavailable' })
      return failed({ code: 'recovery_unavailable' })
    }

    const passwordHash = await this.#hasher.hash(password.value)
    const at = this.#clock.now()

    const sessionsRevoked = await this.#database.transaction(async (repositories) => {
      await repositories.owner.changePassword(passwordHash, at)
      const revoked = await repositories.sessions.removeAll()
      await repositories.audit.record({
        action: 'owner.recovery',
        outcome: 'success',
        detail: { sessionsRevoked: revoked },
        at,
      })
      return revoked
    })

    this.#throttle.recordSuccess('recovery', source)
    return { ok: true, value: { sessionsRevoked } }
  }

  async #issueSession(
    repositories: Repositories,
    userAgent: string | null,
    at: Date,
  ): Promise<IssuedSession> {
    const id = randomSecret()
    const secret = randomSecret()
    const csrfToken = randomSecret()
    const expiresAt = this.#expiry(at)

    await repositories.sessions.create({
      id,
      secretHash: hashSecret(secret),
      csrfToken,
      createdAt: at,
      lastSeenAt: at,
      expiresAt,
      userAgent,
    })

    return { cookieValue: `${id}.${secret}`, csrfToken, expiresAt, sessionId: id }
  }

  /**
   * A hash of a value nobody holds, used to spend the same verification cost
   * when there is no Owner to check against. It is built with the configured
   * hasher so its cost matches a real credential's.
   */
  #unmatchable: Promise<string> | null = null

  async #unmatchableHash(): Promise<string> {
    this.#unmatchable ??= this.#hasher.hash(randomSecret())
    return await this.#unmatchable
  }

  #expiry(from: Date): Date {
    return new Date(from.getTime() + this.#idleSeconds * 1000)
  }

  #tokenMatches(configured: string | undefined, supplied: unknown): boolean {
    if (configured === undefined) return false
    if (typeof supplied !== 'string') return false
    return secretsMatch(configured, supplied)
  }

  async #audit(action: string, outcome: 'success' | 'failure', detail?: unknown): Promise<void> {
    await this.#database.audit.record({ action, outcome, detail, at: this.#clock.now() })
  }
}

function failed(failure: IdentityFailure): IdentityResult<never> {
  return { ok: false, failure }
}
