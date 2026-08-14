import { SecretCipherError, type SecretCipher } from '../crypto/index.ts'
import type { AdapterRegistry } from '../providers/adapter-registry.ts'
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
   * The default Usage Adapter. Used when no `adapterRegistry` is supplied, or
   * when a Provider has no template or its template names an unknown adapter.
   * The single adapter is the whole story in tests and in builds that ship
   * without typed adapters; production runs that ship typed adapters supply
   * an `adapterRegistry` and the default is only the fallback.
   */
  readonly adapter: UsageAdapter
  /**
   * Optional. When supplied, the service resolves each Provider's adapter
   * from its template's `usageAdapterId` at poll time. The default `adapter`
   * is still used as the fallback for Providers with no template, a null
   * `usageAdapterId`, or an unknown id — so a misconfigured runtime never
   * blocks a poll, it just falls back to the reactive-only reading.
   */
  readonly adapterRegistry?: AdapterRegistry
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
 * The view the Owner reads: the last successful normalized readings (one per
 * model for per-model adapters, one for per-account adapters), the latest
 * polling failure (when one happened), and freshness for each. Stale stays
 * distinct from unknown: a long-ago success is still authoritative until a
 * fresher failure or success arrives. The list is empty when no poll ever
 * succeeded.
 */
export interface UsageView {
  readonly visibility: UsageVisibility
  /** The last successful normalized readings, empty when no poll ever succeeded. */
  readonly readings: readonly UsageReading[]
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
  readonly #adapterRegistry: AdapterRegistry | null
  readonly #clock: Clock
  readonly #pollIntervalMs: number
  readonly #failureBackoffMs: number
  /** Tracks consecutive failures per connection to back the failure interval up. */
  readonly #failureStreak = new Map<string, number>()

  constructor(options: UsageServiceOptions) {
    this.#database = options.database
    this.#cipher = options.cipher
    this.#adapter = options.adapter
    this.#adapterRegistry = options.adapterRegistry ?? null
    this.#clock = options.clock ?? systemClock
    this.#pollIntervalMs = (options.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000
    this.#failureBackoffMs = (options.failureBackoffSeconds ?? DEFAULT_FAILURE_BACKOFF_SECONDS) * 1000
  }

  /**
   * Resolves the Usage Adapter for one Provider. When an `adapterRegistry`
   * is configured and the Provider's template names a registered adapter,
   * that adapter is returned. Otherwise the default `adapter` is returned
   * — the reactive-only reading stays honest about its lack of authority.
   */
  #adapterFor(provider: ProviderRecord): UsageAdapter {
    if (this.#adapterRegistry === null) return this.#adapter
    if (provider.templateId === null) return this.#adapter
    const template = this.#adapterRegistry.providerTemplate(provider.templateId)
    if (template === null) return this.#adapter
    if (template.usageAdapterId === null) return this.#adapter
    const typed = this.#adapterRegistry.usageAdapter(template.usageAdapterId)
    return typed ?? this.#adapter
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
    const adapter = this.#adapterFor(connection)
    const visibility = adapter.visibility
    const poll = await adapter.read({
      baseUrl: target.value.baseUrl,
      allowInsecureHttp: target.value.allowInsecureHttp,
      upstreamKey: target.value.upstreamKey,
      signal: null,
    })

    const prior = await this.#database.usage.get(providerId)
    const next = await this.#recordOutcome(providerId, prior, at, poll, visibility)

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
                visibility,
                readings: poll.readings.length,
                scope: poll.readings[0]?.scope.kind ?? 'unknown',
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
   * stale, or no reading proves remaining capacity.
   */
  async recoveryEvidenceFor(providerId: string): Promise<UsageRecoveryEvidence | null> {
    const snapshot = await this.#database.usage.get(providerId)
    if (snapshot === null) return null
    if (snapshot.visibility !== 'authoritative') return null
    if (snapshot.lastSuccessAt === null) return null
    const readings = normalizeReadings(snapshot.result)
    if (readings.length === 0) return null

    const at = snapshot.lastSuccessAt
    // Capacity is the strongest of any reading: any positive balance reactivates.
    const best = readings.reduce<UsageReading | null>((acc, reading) => {
      if (acc === null) return reading
      if (acc.balance === null) return reading
      if (reading.balance === null) return acc
      return reading.balance > acc.balance ? reading : acc
    }, null)

    const evidence = best === null ? null : recoveryEvidenceOf(best, at)

    if (evidence === null) return null

    // Stale readings never reactive capacity; freshness matters.
    const ageMs = this.#clock.now().getTime() - at.getTime()
    if (ageMs > this.#pollIntervalMs * 4) return null

    return evidence
  }

  /** The Capacity Scope the snapshot's readings share at the provider level. */
  async scopeOf(providerId: string): Promise<UsageCapacityScope | null> {
    const snapshot = await this.#database.usage.get(providerId)
    if (snapshot === null) return null
    const readings = normalizeReadings(snapshot.result)
    if (readings.length === 0) return null
    return readings[0]?.scope ?? null
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
    visibility: UsageVisibility,
  ): Promise<UsageServiceResult<UsageView>> {
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
        result: poll.readings,
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
    readings: normalizeReadings(snapshot?.result),
    syncedAt: snapshot?.syncedAt ?? null,
    lastSuccessAt: snapshot?.lastSuccessAt ?? null,
    lastFailureAt: snapshot?.lastFailureAt ?? null,
    lastFailureCode: snapshot?.lastFailureCode ?? null,
    lastFailureMessage: snapshot?.lastFailureMessage ?? null,
    stale,
    nextPollAllowedAt,
  }
}

/**
 * The Usage Snapshot's `result` is persisted via JSON.stringify and recovered
 * via JSON.parse, which round-trips Dates as ISO strings — not Date instances.
 * The TypeScript interface claims `UsageReading.resetAt: Date | null`, which
 * is the value as the adapter produced it; after a storage roundtrip the value
 * is a string. Normalise here so the rest of the service can rely on the
 * declared shape and the HTTP DTO's `toISOString()` calls never blow up.
 *
 * Accepts either the current `UsageReading[]` shape or the legacy single
 * `UsageReading` shape that pre-dates the multi-reading contract — old rows
 * are read back as a one-element list so the UI does not have to fork.
 */
function normalizeReadings(raw: unknown): readonly UsageReading[] {
  if (raw === null) return []
  if (Array.isArray(raw)) {
    const out: UsageReading[] = []
    for (const entry of raw) {
      const reading = normalizeReading(entry)
      if (reading !== null) out.push(reading)
    }
    return out
  }
  const legacy = normalizeReading(raw)
  return legacy === null ? [] : [legacy]
}

function normalizeReading(raw: unknown): UsageReading | null {
  if (raw === null) return null
  if (typeof raw !== 'object') return null
  const r = raw as Partial<UsageReading> & { resetAt?: unknown }
  const resetAt =
    typeof r.resetAt === 'string'
      ? new Date(r.resetAt)
      : r.resetAt instanceof Date
        ? r.resetAt
        : null
  return { ...(r as UsageReading), resetAt }
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
