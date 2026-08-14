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

/** One eligible Upstream Key the service will poll this refresh. */
interface UsagePollTarget {
  readonly baseUrl: string
  readonly allowInsecureHttp: boolean
  readonly upstreamKey: string
  /** The eligible Upstream Key this poll is talking to; one of the connection's keys. */
  readonly candidate: UpstreamKeyRecord
}

/**
 * The per-key storage the snapshot's `result` carries. Each entry's readings
 * are tagged with the matching `keyId` so the UI can route them to the right
 * row. An entry is `undefined` when the last poll for that key failed; the
 * prior entry is preserved across failures so a temporarily-down key
 * doesn't blank its row, and overwritten on a successful poll so a
 * permanently-down key eventually clears once the next eligible poll
 * succeeds.
 */
type PerKeyReadings = Readonly<Record<string, readonly UsageReading[]>>

/** A failure attached to the refresh's connection-level failure metadata. */
interface UsageFailureRecord {
  readonly at: Date
  readonly code: string
  readonly message: string
  readonly retryAfterSeconds: number | null
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
   * Polls the connection's configured Usage Adapter once per eligible
   * Upstream Key, in parallel, persists the per-key outcome, and returns
   * the updated view. A failure on one key never erases another key's
   * previously successful reading; the prior reading is preserved for that
   * key only. The connection-level `lastFailureAt`/`Code`/`Message` track
   * the most recent failure across all keys so the Owner still sees a
   * single, latest error for the connection.
   */
  async refresh(providerId: string): Promise<UsageServiceResult<UsageView>> {
    const connection = await this.#database.providers.getProvider(providerId)
    if (connection === null) return failed({ code: 'provider_not_found' })
    if (connection.archivedAt !== null) return failed({ code: 'provider_archived' })
    if (!connection.enabled) return failed({ code: 'provider_disabled' })

    const targets = await this.#resolveTargets(connection)
    if (!targets.ok) return targets

    const at = this.#clock.now()
    const adapter = this.#adapterFor(connection)
    const visibility = adapter.visibility

    const polls = await Promise.all(
      targets.value.map(async (target) => {
        const poll = await adapter.read({
          baseUrl: target.baseUrl,
          allowInsecureHttp: target.allowInsecureHttp,
          upstreamKey: target.upstreamKey,
          signal: null,
        })
        return { target, poll }
      }),
    )

    const prior = await this.#database.usage.get(providerId)
    const next = await this.#recordOutcome(providerId, prior, at, polls, visibility)

    const anySuccess = polls.some(({ poll }) => poll.ok)
    if (anySuccess) {
      this.#failureStreak.delete(providerId)
    } else {
      this.#bumpFailureStreak(providerId)
    }

    if (next.ok) {
      const successfulKeys = polls.filter(({ poll }) => poll.ok).length
      const failedKeys = polls.length - successfulKeys
      await this.#database.audit.record({
        action: 'usage.refreshed',
        outcome: successfulKeys > 0 || polls.length === 0 ? 'success' : 'failure',
        detail: {
          providerId,
          visibility,
          polledKeys: polls.length,
          successfulKeys,
          failedKeys,
          readings: next.value.readings.length,
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

  /**
   * Every pollable key becomes one target polled against the URL the key
   * actually routes through at inference time: the key's own override when it
   * has one, the connection base URL otherwise.
   */
  async #resolveTargets(
    connection: ProviderRecord,
  ): Promise<UsageServiceResult<readonly UsagePollTarget[]>> {
    const keys = await this.#database.providers.listKeys(connection.id)
    const eligible = keys.filter(
      (key) => key.health === 'active' || key.health === 'unverified'
        || key.health === 'cooling_down' || key.health === 'exhausted',
    )
    if (eligible.length === 0) return failed({ code: 'no_eligible_key' })

    const targets: UsagePollTarget[] = []
    for (const key of eligible) {
      let plaintext: string
      try {
        plaintext = await this.#cipher.decrypt(key.encryptedKey)
      } catch (cause) {
        if (cause instanceof SecretCipherError) return failed({ code: 'stored_key_unreadable' })
        throw cause
      }
      targets.push({
        baseUrl: key.baseUrl ?? connection.baseUrl,
        allowInsecureHttp: connection.allowInsecureHttp,
        upstreamKey: plaintext,
        candidate: key,
      })
    }
    return { ok: true, value: targets }
  }

  async #recordOutcome(
    providerId: string,
    prior: UsageSnapshotRecord | null,
    at: Date,
    polls: ReadonlyArray<{ readonly target: UsagePollTarget; readonly poll: UsagePollResult }>,
    visibility: UsageVisibility,
  ): Promise<UsageServiceResult<UsageView>> {
    const priorByKey = prior === null ? {} : perKeyMapFromSnapshot(prior.result)
    const nextByKey: Record<string, readonly UsageReading[]> = { ...priorByKey }

    // Track the freshest success and failure across the polls. A successful
    // poll for a key replaces that key's prior entry; a failed poll leaves
    // the prior entry in place so a temporarily down key doesn't blank its
    // row. Keys that disappeared from the eligible list since the last
    // refresh (e.g. the Owner disabled one) keep their prior entry for one
    // cycle; they get dropped on the next successful refresh that lists
    // them as no longer eligible.
    let latestSuccessAt: Date | null = prior?.lastSuccessAt ?? null
    let latestFailure: UsageFailureRecord | null = null
    if (prior?.lastFailureAt !== null && prior?.lastFailureAt !== undefined
      && prior.lastFailureCode !== null && prior.lastFailureMessage !== null) {
      latestFailure = {
        at: prior.lastFailureAt,
        code: prior.lastFailureCode,
        message: prior.lastFailureMessage,
        retryAfterSeconds: null,
      }
    }

    for (const { target, poll } of polls) {
      const keyId = target.candidate.id
      if (poll.ok) {
        nextByKey[keyId] = poll.readings.map((reading) => ({ ...reading, keyId }))
        if (latestSuccessAt === null || at.getTime() > latestSuccessAt.getTime()) {
          latestSuccessAt = at
        }
        continue
      }

      const message = messageFor(poll.failure)
      const retryAfterSeconds = poll.failure.code === 'rate_limited'
        ? Math.max(1, poll.failure.retryAfterSeconds)
        : null
      const record: UsageFailureRecord = { at, code: poll.failure.code, message, retryAfterSeconds }
      if (latestFailure === null || record.at.getTime() >= latestFailure.at.getTime()) {
        latestFailure = record
      }
    }

    const eligibleIds = new Set(polls.map(({ target }) => target.candidate.id))
    for (const keyId of Object.keys(nextByKey)) {
      if (!eligibleIds.has(keyId)) delete nextByKey[keyId]
    }

    const next: UsageSnapshotRecord = {
      providerId,
      visibility,
      syncedAt: at,
      lastSuccessAt: latestSuccessAt,
      lastFailureAt: latestFailure?.at ?? prior?.lastFailureAt ?? null,
      lastFailureCode: latestFailure?.code ?? prior?.lastFailureCode ?? null,
      lastFailureMessage: latestFailure?.message ?? prior?.lastFailureMessage ?? null,
      result: nextByKey,
    }

    await this.#database.usage.put(next)

    const rateLimit = latestFailure?.code === 'rate_limited' ? latestFailure : null
    if (rateLimit !== null) {
      const retryAfterSeconds = rateLimit.retryAfterSeconds ?? 1
      return failed({
        code: 'rate_limited',
        retryAfterSeconds,
        retryAt: new Date(rateLimit.at.getTime() + retryAfterSeconds * 1000),
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
 * Accepts three shapes, oldest first:
 *
 * 1. A single `UsageReading` object (the original contract, pre multi-reading).
 * 2. A flat `UsageReading[]` (the multi-reading contract, pre per-key).
 * 3. A `Record<keyId, UsageReading[]>` (the per-key contract; current).
 *
 * The legacy shapes come back with `keyId: null` on every reading; the new
 * shape preserves the per-key attribution. Every reading's `resetAt` is
 * coerced to a `Date` so the HTTP DTO can call `toISOString()` on it.
 */
function normalizeReadings(raw: unknown): readonly UsageReading[] {
  if (raw === null) return []
  if (Array.isArray(raw)) {
    const out: UsageReading[] = []
    for (const entry of raw) {
      const reading = normalizeReading(entry, null)
      if (reading !== null) out.push(reading)
    }
    return out
  }
  if (typeof raw === 'object') {
    const recordLike = raw as Record<string, unknown>
    const looksLikePerKeyMap = Object.values(recordLike).every(
      (value) => Array.isArray(value) || value === null,
    )
    if (looksLikePerKeyMap) {
      const out: UsageReading[] = []
      for (const [keyId, value] of Object.entries(recordLike)) {
        if (value === null) continue
        if (!Array.isArray(value)) continue
        for (const entry of value) {
          const reading = normalizeReading(entry, keyId)
          if (reading !== null) out.push(reading)
        }
      }
      return out
    }
  }
  const legacy = normalizeReading(raw, null)
  return legacy === null ? [] : [legacy]
}

function normalizeReading(raw: unknown, keyId: string | null): UsageReading | null {
  if (raw === null) return null
  if (typeof raw !== 'object') return null
  const r = raw as Partial<UsageReading> & { resetAt?: unknown; keyId?: unknown }
  const resetAt =
    typeof r.resetAt === 'string'
      ? new Date(r.resetAt)
      : r.resetAt instanceof Date
        ? r.resetAt
        : null
  // A legacy reading may carry no `keyId` field; the caller's hint wins
  // unless the reading already has one (the per-key map writes it; the
  // flat list doesn't).
  const resolvedKeyId = typeof r.keyId === 'string' ? r.keyId : keyId
  return { ...(r as UsageReading), resetAt, keyId: resolvedKeyId }
}

/**
 * Reads the snapshot's `result` back into the per-key map shape the writer
 * produces. Used by `#recordOutcome` so a partial failure can preserve the
 * prior readings for keys that didn't successfully poll this round. Legacy
 * flat-list and single-reading snapshots are flattened: the readings are
 * treated as connection-wide (`keyId: null`) and dropped, because the writer
 * will rebuild the per-key map on the next successful refresh.
 */
function perKeyMapFromSnapshot(raw: unknown): Record<string, readonly UsageReading[]> {
  if (raw === null || typeof raw !== 'object') return {}
  const recordLike = raw as Record<string, unknown>
  const looksLikePerKeyMap = Object.values(recordLike).every(
    (value) => Array.isArray(value) || value === null,
  )
  if (!looksLikePerKeyMap) return {}
  const out: Record<string, readonly UsageReading[]> = {}
  for (const [keyId, value] of Object.entries(recordLike)) {
    if (!Array.isArray(value)) continue
    out[keyId] = value.map((entry) => {
      const reading = normalizeReading(entry, keyId)
      if (reading === null) return null
      return reading
    }).filter((reading): reading is UsageReading => reading !== null)
  }
  return out
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
