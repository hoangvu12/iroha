import { SecretCipherError, type SecretCipher } from '../crypto/index.ts'
import type { AdapterRegistry } from '../providers/adapter-registry.ts'
import { systemClock, type Clock } from '../runtime/clock.ts'
import { reconcileCapacity } from '../providers/capacity-reconciliation.ts'
import type { CapacityEvidence } from '../providers/provider-evidence.ts'
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
  /** Maximum simultaneous per-Key entitlement reads for one Provider. */
  readonly pollingConcurrency?: number
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
  readonly #pollingConcurrency: number
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
    this.#pollingConcurrency = Math.max(1, Math.floor(options.pollingConcurrency ?? 4))
  }

  /**
   * Resolves the Usage Adapter for one Provider. When an `adapterRegistry`
   * is configured and the Provider's template names a registered adapter,
   * that typed adapter is returned; otherwise the default `adapter` is
   * returned — the reactive-only reading stays honest about its lack of
   * authority. The template-to-adapter walk lives in the Adapter Registry,
   * the single mechanism the inference path resolves through too, so the two
   * paths cannot disagree about a Provider's adapters.
   */
  #adapterFor(provider: ProviderRecord): UsageAdapter {
    return this.#adapterRegistry?.typedUsageAdapter(provider.templateId) ?? this.#adapter
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
  async refresh(
    providerId: string,
    options: { readonly force?: boolean } = {},
  ): Promise<UsageServiceResult<UsageView>> {
    const connection = await this.#database.providers.getProvider(providerId)
    if (connection === null) return failed({ code: 'provider_not_found' })
    if (connection.archivedAt !== null) return failed({ code: 'provider_archived' })
    if (!connection.enabled) return failed({ code: 'provider_disabled' })

    const targets = await this.#resolveTargets(connection, options.force ?? true)
    if (!targets.ok) return targets

    const at = this.#clock.now()
    const adapter = this.#adapterFor(connection)
    const visibility = adapter.visibility

    const polls = await mapWithConcurrency(
      targets.value,
      this.#pollingConcurrency,
      async (target) => {
        const poll = await adapter.read({
          baseUrl: target.baseUrl,
          allowInsecureHttp: target.allowInsecureHttp,
          upstreamKey: target.upstreamKey,
          signal: null,
        })
        return { target, poll }
      },
    )

    const prior = await this.#database.usage.get(providerId)
    const next = await this.#recordOutcome(providerId, prior, at, polls, visibility)

    await Promise.all(polls.map(async ({ target, poll }) => {
      if (!poll.ok) return
      const evidence = poll.readings.map((reading) =>
        adapter.capacityEvidenceOf?.(reading, target.candidate.id, at)
          ?? capacityEvidenceFromReading(reading, target.candidate.id, at)
      )
      await this.#reconcileKey(connection, target.candidate, evidence, at)
    }))

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

  /** Tracks one in-flight capacity-failure refresh per Provider. */
  readonly #inflightRefresh = new Map<string, Promise<void>>()

  /**
   * Called after a capacity-related inference failure. Refreshes the
   * Provider's usage snapshot so routing can reconcile fresh capacity
   * without waiting for the next scheduled poll — but only when the Provider
   * actually has a Usage Adapter implemented. A Provider whose template
   * resolves to the reactive-only generic adapter has no usage to read, so
   * the call is a no-op and never triggers a pointless
   * poll.
   *
   * Concurrent failure signals for one Provider collapse into a single poll: the
   * first caller runs the refresh and every caller after it awaits the same
   * in-flight promise, so a burst of requests cannot stack parallel polls
   * against the Provider's entitlement API.
   */
  async refreshAfterCapacityFailure(providerId: string): Promise<void> {
    const existing = this.#inflightRefresh.get(providerId)
    if (existing !== undefined) {
      await existing
      return
    }
    const run = this.#refreshAfterCapacityFailureUnsafe(providerId)
    this.#inflightRefresh.set(providerId, run)
    try {
      await run
    } finally {
      this.#inflightRefresh.delete(providerId)
    }
  }

  async #refreshAfterCapacityFailureUnsafe(providerId: string): Promise<void> {
    const connection = await this.#database.providers.getProvider(providerId)
    if (connection === null) return
    const adapter = this.#adapterFor(connection)
    if (adapter.visibility !== 'authoritative') return
    await this.refresh(providerId)
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

    let evidence = best === null ? null : recoveryEvidenceOf(best, at)

    // Per-Key polling means a Provider- or model-scoped reading was obtained
    // with one specific key's entitlement. It must not revive unrelated keys
    // whose own authoritative readings say they have no capacity. Explicit
    // account scopes remain shared because the Owner grouped those keys.
    const perKeyCapacity = readings
      .filter((reading) => reading.keyId !== null)
      .map((reading) => recoveryEvidenceOf(reading, at).hasCapacity)
    const hasMixedPerKeyCapacity = perKeyCapacity.includes(true) && perKeyCapacity.includes(false)

    if (
      evidence !== null &&
      hasMixedPerKeyCapacity &&
      best?.keyId !== null &&
      best?.keyId !== undefined &&
      (evidence.scope.kind === 'provider' || evidence.scope.kind === 'connection_model')
    ) {
      evidence = { ...evidence, scope: { kind: 'key', keyId: best.keyId } }
    }

    if (evidence === null) return null

    // Stale readings never reactive capacity; freshness matters.
    const ageMs = this.#clock.now().getTime() - at.getTime()
    if (ageMs > this.#pollIntervalMs * 4) return null

    return evidence
  }

  /** Returns only fresh authoritative normalized evidence for one key. */
  async capacityEvidenceFor(
    providerId: string,
    keyId: string,
    maxAgeMs = 60_000,
  ): Promise<readonly CapacityEvidence[]> {
    const connection = await this.#database.providers.getProvider(providerId)
    const snapshot = await this.#database.usage.get(providerId)
    if (connection === null || snapshot === null || snapshot.visibility !== 'authoritative'
      || snapshot.lastSuccessAt === null || this.#isStale(snapshot)) return []
    const key = await this.#database.providers.getKey(keyId)
    if (key === null || key.providerId !== providerId) return []
    const age = this.#clock.now().getTime() - snapshot.lastSuccessAt.getTime()
    if (age < 0 || age > maxAgeMs) return []
    const adapter = this.#adapterFor(connection)
    return normalizeReadings(snapshot.result)
      .filter((reading) => reading.keyId === keyId)
      .map((reading) => adapter.capacityEvidenceOf?.(reading, keyId, snapshot.lastSuccessAt!)
        ?? capacityEvidenceFromReading(reading, keyId, snapshot.lastSuccessAt!))
      .filter((evidence) => evidence.authority === 'authoritative')
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
    force: boolean,
  ): Promise<UsageServiceResult<readonly UsagePollTarget[]>> {
    const at = this.#clock.now()
    const keys = await this.#database.providers.listKeys(connection.id)
    const eligible = keys.filter(
      (key) => key.health === 'active' || key.health === 'unverified'
        || key.health === 'cooling_down'
        || key.health === 'exhausted' && (force || key.retryAfterAt === null || key.retryAfterAt <= at),
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

  async #reconcileKey(
    connection: ProviderRecord,
    key: UpstreamKeyRecord,
    evidence: readonly CapacityEvidence[],
    at: Date,
  ): Promise<void> {
    const current = await this.#database.providers.getKey(key.id) ?? key
    const modelEvidence = evidence.find((item) => item.scope.kind === 'connection_model')
    const decision = reconcileCapacity({
      ownerEnabled: connection.enabled && current.health !== 'disabled',
      keyId: current.id,
      accountId: current.accountId,
      model: modelEvidence?.scope.kind === 'connection_model' ? modelEvidence.scope.model : null,
      existing: {
        health: current.health,
        reason: current.healthReason,
        retryAfterAt: current.retryAfterAt,
        scope: current.healthScope,
        scopeId: current.healthScopeId,
        model: current.healthModel,
      },
      credentialEvidence: null,
      capacityEvidence: evidence,
      now: at,
    })
    await this.#database.providers.updateKey(current.id, {
      health: decision.health,
      healthReason: decision.reason,
      healthChangedAt: decision.health === current.health ? current.healthChangedAt : at,
      retryAfterAt: decision.nextCheckAt,
      healthScope: decision.scope,
      healthScopeId: decision.scopeId,
      healthModel: decision.model,
    }, at)
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

function capacityEvidenceFromReading(
  reading: UsageReading,
  keyId: string,
  observedAt: Date,
): CapacityEvidence {
  const remaining = reading.balance ?? reading.remainingPercent
  const authoritative = reading.confidence === 'confirmed' && remaining !== null
  const available = authoritative && remaining > 0
  const exhausted = authoritative && remaining <= 0
  return {
    availability: available ? 'available' : exhausted ? 'exhausted' : 'unknown',
    authority: authoritative ? 'authoritative' : 'unknown',
    // Per-key polling attributes otherwise broad endpoint readings to the
    // credential whose entitlement was actually observed.
    scope: reading.scope.kind === 'connection_model'
      ? { kind: 'connection_model', model: reading.scope.model }
      : reading.scope.kind === 'account'
        ? { kind: 'account', accountId: reading.scope.accountId }
        : reading.scope.kind === 'unknown'
          ? { kind: 'unknown' }
          : { kind: 'key', keyId },
    reason: available ? 'positive_entitlement'
      : exhausted ? reading.balance === null ? 'window_exhausted' : 'credit_exhausted'
      : 'unknown',
    observedAt,
    freshUntil: new Date(observedAt.getTime() + 60_000),
    recheckAt: reading.resetAt,
    facts: {
      ...(reading.balance === null ? {} : { remaining: reading.balance }),
      ...(reading.remainingPercent === null ? {} : { remainingPercent: reading.remainingPercent }),
      ...(reading.used === null ? {} : { used: reading.used }),
      ...(reading.limit === null ? {} : { limit: reading.limit }),
      unit: reading.unit,
    },
    diagnostics: {},
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

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  visit: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++
      results[index] = await visit(values[index]!)
    }
  })
  await Promise.all(workers)
  return results
}
