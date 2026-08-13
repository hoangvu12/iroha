import { SecretCipherError, type SecretCipher } from '../crypto/index.ts'
import { systemClock, type Clock } from '../runtime/clock.ts'
import type {
  Database,
  ProviderRecord,
  UpstreamKeyRecord,
  UsageSnapshotRecord,
} from '../persistence/index.ts'
import {
  type UsageAdapter,
  type UsageCapacityScope,
  type UsageFailure,
  type UsagePollResult,
  type UsageReading,
  type UsageRecoveryEvidence,
  type UsageVisibility,
  recoveryEvidenceOf,
} from './adapter.ts'

export interface FieldProblem {
  readonly field: string
  readonly message: string
}

export type UsageServiceFailure =
  | { readonly code: 'provider_not_found' }
  | { readonly code: 'provider_archived' }
  | { readonly code: 'provider_disabled' }
  | { readonly code: 'no_eligible_key' }
  | { readonly code: 'stored_key_unreadable' }
  | { readonly code: 'rate_limited'; readonly retryAfterSeconds: number; readonly retryAt: Date }

export type UsageServiceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: UsageServiceFailure }

/** One attempt to find an eligible key for the poll's upstream request. */
interface UsagePollTarget {
  readonly baseUrl: string
  readonly allowInsecureHttp: boolean
  readonly upstreamKey: string
  /** The eligible Upstream Key this poll is talking to; one of the connection's keys. */
  readonly candidate: UpstreamKeyRecord
}

export interface UsageServiceOptions {
  readonly database: Database
  readonly cipher: SecretCipher
  /**
   * The configured Usage Adapter. The service resolves a per-connection adapter
   * by calling this factory; the same factory is used for every connection so a
   * single adapter owns its state (for example an HTTP client, a cache, or a
   * mock).
   */
  readonly adapter: UsageAdapter
  readonly clock?: Clock
  /**
   * The minimum interval between two successful polls of one connection.
   * A failure shortens the interval, never lengthens it. Defaults to 60
   * seconds Ã¢—‚¬—€ long enough that an idle installation does not hammer a Provider
   * and short enough that the Owner sees fresh data without a manual refresh.
   */
  readonly pollIntervalSeconds?: number
  /**
   * The minimum interval between two failed polls of one connection. The
   * service backs off after repeated failures, capped at the configured poll
   * interval so a healthy state never has to wait longer than its normal
   * cadence. Defaults to 5 seconds.
   */
  readonly failureBackoffSeconds?: number
}

const DEFAULT_POLL_INTERVAL_SECONDS = 60
const DEFAULT_FAILURE_BACKOFF_SECONDS = 5
const MAX_BACKOFF_MULTIPLIER = 6

/**
 * The view the Owner reads: the last successful normalized reading, the
 * latest polling failure (when one happened), and freshness for each. Stale
 * stays distinct from unknown: a long-ago success is still authoritative
 * until a fresher failure or success arrives.
 */
export interface UsageView {
  readonly visibility: UsageVisibility
  /** The last successful normalized reading, or null when no poll ever succeeded. */
  readonly reading: UsageReading | null
  readonly syncedAt: Date | null
  readonly lastSuccessAt: Date | null
  readonly lastFailureAt: Date | null
  readonly lastFailureCode: string | null
  readonly lastFailureMessage: string | null
  /** True when the latest poll failed and no fresher success exists. */
  readonly stale: boolean
  /** Whether the next poll is currently allowed by the cadence. */
  readonly nextPollAllowedAt: Date | null
}

/**
 * The Usage Service: per-connection polling of a typed Usage Adapter, durable
 * snapshot of the last successful reading, the latest failure kept
 * independently, cadence that respects Provider limits and backs off on
 * repeated failures, and authoritative recovery evidence when the adapter
 * supplies it.
 *
 * The service never claims authority it cannot prove. A reactive-only
 * adapter's reading is still persisted, but its scope, confidence, and the
 * "confirmed zero is not zero is not unknown" rule are read back by the Owner
 * UI exactly the way the adapter declared them.
 */
export class UsageService {
  readonly #database: Database
  readonly #cipher: SecretCipher
  readonly #adapter: UsageAdapter
  readonly #clock: Clock
  readonly #pollIntervalMs: number
  readonly #failureBackoffMs: number
  /** Tracks consecutive failures per connection to back the failure interval up. */
  readonly #failureStreak = new Map<string, number>()

  constructor(options: UsageServiceOptions) {
    this.#database = options.database
    this.#cipher = options.cipher
    this.#adapter = options.adapter
    this.#clock = options.clock ?? systemClock
    this.#pollIntervalMs = (options.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000
    this.#failureBackoffMs = (options.failureBackoffSeconds ?? DEFAULT_FAILURE_BACKOFF_SECONDS) * 1000
  }

  /** The view the Owner sees for one connection: reading, freshness, last error. */
  async view(providerId: string): Promise<UsageServiceResult<UsageView>> {
    const connection = await this.#database.providers.getProvider(providerId)
    if (connection === null) return failed({ code: 'provider_not_found' })
    if (connection.archivedAt !== null) return failed({ code: 'provider_archived' })

    const snapshot = await this.#database.usage.get(providerId)
    const stale = snapshot?.lastFailureAt !== null && snapshot?.lastFailureAt !== undefined
      ? this.#isStale(snapshot)
      : false
    const nextPollAllowedAt = this.#nextPollAllowedAt(snapshot)

    return {
      ok: true,
      value: toView(snapshot, stale, nextPollAllowedAt),
    }
  }

  /**
   * Polls the connection's configured Usage Adapter once, persists the
   * outcome, and returns the updated view. A polling failure never erases the
   * previously successful reading; it is recorded separately so the Owner can
   * read the latest of each.
   */
  async refresh(providerId: string): Promise<UsageServiceResult<UsageView>> {
    const connection = await this.#database.providers.getProvider(providerId)
    if (connection === null) return failed({ code: 'provider_not_found' })
    if (connection.archivedAt !== null) return failed({ code: 'provider_archived' })
    if (!connection.enabled) return failed({ code: 'provider_disabled' })

    const target = await this.#resolveTarget(connection)
    if (!target.ok) return target

    const at = this.#clock.now()
    const poll = await this.#adapter.read({
      baseUrl: target.value.baseUrl,
      allowInsecureHttp: target.value.allowInsecureHttp,
      upstreamKey: target.value.upstreamKey,
      signal: null,
    })

    const prior = await this.#database.usage.get(providerId)
    const next = await this.#recordOutcome(providerId, prior, at, poll)

    if (poll.ok) {
      this.#failureStreak.delete(providerId)
    } else if (poll.failure.code === 'rate_limited') {
      this.#bumpFailureStreak(providerId)
    } else {
      this.#bumpFailureStreak(providerId)
    }

    if (next.ok) {
      await this.#database.audit.record({
        action: 'usage.refreshed',
        outcome: poll.ok ? 'success' : 'failure',
        detail: {
          providerId,
          ...(poll.ok
            ? {
                visibility: poll.reading.confidence === 'confirmed' ? 'authoritative' : 'reactive_only',
                scope: poll.reading.scope.kind,
                balance: poll.reading.balance,
              }
            : {
                code: poll.failure.code,
              }),
        },
        at,
      })
    }

    return next
  }

  /**
   * Resolves authoritative recovery evidence from the latest snapshot. Returns
   * `null` when the adapter is reactive-only, the latest reading is too
   * stale, or the reading does not prove remaining capacity.
   */
  async recoveryEvidenceFor(providerId: string): Promise<UsageRecoveryEvidence | null> {
    const snapshot = await this.#database.usage.get(providerId)
    if (snapshot === null) return null
    if (snapshot.result === null) return null
    if (snapshot.visibility !== 'authoritative') return null
    if (snapshot.lastSuccessAt === null) return null

    const reading = snapshot.result as UsageReading
    const at = snapshot.lastSuccessAt
    const evidence = recoveryEvidenceOf(reading, at)

    // Stale readings never reactive capacity; freshness matters.
    const ageMs = this.#clock.now().getTime() - at.getTime()
    if (ageMs > this.#pollIntervalMs * 4) return null

    return evidence
  }

  /** The Capacity Scope the snapshot's reading proves capacity at. */
  async scopeOf(providerId: string): Promise<UsageCapacityScope | null> {
    const snapshot = await this.#database.usage.get(providerId)
    if (snapshot === null || snapshot.result === null) return null
    return (snapshot.result as UsageReading).scope
  }

  async #resolveTarget(
    connection: ProviderRecord,
  ): Promise<UsageServiceResult<UsagePollTarget>> {
    const keys = await this.#database.providers.listKeys(connection.id)
    const eligible = keys.find((key) => key.health === 'active' || key.health === 'unverified')
      ?? keys.find((key) => key.health !== 'disabled')
    if (eligible === undefined) return failed({ code: 'no_eligible_key' })

    try {
      const plaintext = await this.#cipher.decrypt(eligible.encryptedKey)
      return {
        ok: true,
        value: {
          baseUrl: connection.baseUrl,
          allowInsecureHttp: connection.allowInsecureHttp,
          upstreamKey: plaintext,
          candidate: eligible,
        },
      }
    } catch (cause) {
      if (cause instanceof SecretCipherError) return failed({ code: 'stored_key_unreadable' })
      throw cause
    }
  }

  async #recordOutcome(
    providerId: string,
    prior: UsageSnapshotRecord | null,
    at: Date,
    poll: UsagePollResult,
  ): Promise<UsageServiceResult<UsageView>> {
    const visibility = this.#adapter.visibility
    let next: UsageSnapshotRecord

    if (poll.ok) {
      next = {
        providerId,
        visibility,
        syncedAt: at,
        lastSuccessAt: at,
        lastFailureAt: prior?.lastFailureAt ?? null,
        lastFailureCode: prior?.lastFailureCode ?? null,
        lastFailureMessage: prior?.lastFailureMessage ?? null,
        result: poll.reading,
      }
    } else {
      next = {
        providerId,
        visibility,
        syncedAt: at,
        lastSuccessAt: prior?.lastSuccessAt ?? null,
        lastFailureAt: at,
        lastFailureCode: poll.failure.code,
        lastFailureMessage: messageFor(poll.failure),
        result: prior?.result ?? null,
      }
    }

    await this.#database.usage.put(next)

    if (!poll.ok && poll.failure.code === 'rate_limited') {
      const retryAfterSeconds = Math.max(1, poll.failure.retryAfterSeconds)
      return failed({
        code: 'rate_limited',
        retryAfterSeconds,
        retryAt: new Date(at.getTime() + retryAfterSeconds * 1000),
      })
    }

    const stale = this.#isStale(next)
    const nextPollAllowedAt = this.#nextPollAllowedAt(next)
    return {
      ok: true,
      value: toView(next, stale, nextPollAllowedAt),
    }
  }

  /** A snapshot is stale when a fresh failure landed on top of a previous success. */
  #isStale(snapshot: UsageSnapshotRecord): boolean {
    if (snapshot.lastFailureAt === null) return false
    if (snapshot.lastSuccessAt === null) return false
    return snapshot.lastFailureAt.getTime() > snapshot.lastSuccessAt.getTime()
  }

  #nextPollAllowedAt(snapshot: UsageSnapshotRecord | null): Date | null {
    if (snapshot === null || snapshot.syncedAt === null) return null
    const streak = this.#failureStreak.get(snapshot.providerId) ?? 0
    const baseInterval = this.#failureIntervalMs(snapshot, streak)
    return new Date(snapshot.syncedAt.getTime() + baseInterval)
  }

  /**
   * Picks the next poll interval: the normal interval after a success, an
   * exponentially backed-off interval after repeated failures, capped at the
   * normal interval so recovery is never slow.
   */
  #failureIntervalMs(snapshot: UsageSnapshotRecord, streak: number): number {
    const lastFailureAt = snapshot.lastFailureAt
    const lastSuccessAt = snapshot.lastSuccessAt
    const failed = lastFailureAt !== null
    const failedAfterSuccess =
      failed && (lastSuccessAt === null || lastFailureAt.getTime() >= lastSuccessAt.getTime())

    if (!failedAfterSuccess) return this.#pollIntervalMs

    const multiplier = Math.min(streak, MAX_BACKOFF_MULTIPLIER)
    return Math.min(this.#pollIntervalMs, this.#failureBackoffMs * 2 ** Math.max(0, multiplier - 1))
  }

  #bumpFailureStreak(providerId: string): void {
    this.#failureStreak.set(providerId, (this.#failureStreak.get(providerId) ?? 0) + 1)
  }
}

function toView(
  snapshot: UsageSnapshotRecord | null,
  stale: boolean,
  nextPollAllowedAt: Date | null,
): UsageView {
  return {
    visibility: snapshot?.visibility ?? 'reactive_only',
    reading: (snapshot?.result as UsageReading | null) ?? null,
    syncedAt: snapshot?.syncedAt ?? null,
    lastSuccessAt: snapshot?.lastSuccessAt ?? null,
    lastFailureAt: snapshot?.lastFailureAt ?? null,
    lastFailureCode: snapshot?.lastFailureCode ?? null,
    lastFailureMessage: snapshot?.lastFailureMessage ?? null,
    stale,
    nextPollAllowedAt,
  }
}

function messageFor(failure: UsageFailure): string {
  switch (failure.code) {
    case 'upstream_unreachable':
      return failure.message
    case 'upstream_refused':
      return `the provider refused the entitlement poll (HTTP ${failure.status})`
    case 'unparseable_response':
      return failure.message
    case 'no_eligible_key':
      return 'no Upstream Key on this connection is usable for entitlement polling'
    case 'stored_key_unreadable':
      return 'a stored Upstream Key could not be read; the installation master key may have changed'
    case 'rate_limited':
      return `the provider rate-limited the entitlement poll; retry after ${failure.retryAfterSeconds}s`
  }
}

function failed(failure: UsageServiceFailure): UsageServiceResult<never> {
  return { ok: false, failure }
}
