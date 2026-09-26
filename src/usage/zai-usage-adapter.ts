import type { CapacityEvidence, ProviderDiagnostics } from '../providers/provider-evidence.ts'
import type { UsageAdapter, UsageAdapterRequest, UsagePollResult, UsageReading } from './adapter.ts'

const QUOTA_PATH = '/api/monitor/usage/quota/limit'
const EVIDENCE_FRESHNESS_MS = 60_000

/** The pay-as-you-go credit windows; a consumed one is the `1113` arrears refusal. */
const CREDIT_LIMIT = 'CREDIT_LIMIT'
/** The coding plan's token usage windows; a consumed one is the `1310` / `1308` refusal. */
const TOKENS_LIMIT = 'TOKENS_LIMIT'

export interface ZaiUsageAdapterOptions {
  readonly fetch?: typeof fetch
  readonly now?: () => Date
}

interface ZaiLimit {
  readonly type?: unknown
  readonly unit?: unknown
  readonly number?: unknown
  readonly usage?: unknown
  readonly currentValue?: unknown
  readonly remaining?: unknown
  readonly percentage?: unknown
  readonly nextResetTime?: unknown
}

function entitlementHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase().endsWith('bigmodel.cn')
      ? 'https://open.bigmodel.cn'
      : 'https://api.z.ai'
  } catch {
    return 'https://api.z.ai'
  }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

function remainingPercent(limit: ZaiLimit): number | null {
  const total = finiteNumber(limit.usage)
  const remaining = finiteNumber(limit.remaining)
  if (total !== null && total > 0 && remaining !== null) {
    return clampPercent((remaining / total) * 100)
  }
  const usedPercent = finiteNumber(limit.percentage)
  return usedPercent === null ? null : clampPercent(100 - usedPercent)
}

function resetAt(value: unknown): Date | null {
  const millis = finiteNumber(value)
  if (millis === null || millis <= 0) return null
  const date = new Date(millis)
  return Number.isFinite(date.getTime()) ? date : null
}

/**
 * Whether a limit entry speaks for chat-completions capacity.
 *
 * The coding-plan response mixes three limit families, and only two of them
 * bind a Chat Completions call:
 *
 *   - `CREDIT_LIMIT` — pay-as-you-go credit windows. A consumed one is the
 *     `1113` insufficient-balance refusal.
 *   - `TOKENS_LIMIT` — the plan's token usage windows. A consumed one is the
 *     `1310` / `1308` window refusal.
 *
 * `TIME_LIMIT` is the tool-call quota (`usageDetails` names search-prime,
 * web-reader, and zread). A key whose tool quota is spent still chats, and a
 * key whose weekly token window is spent still reports the tool quota as
 * unconsumed — reading `TIME_LIMIT` as entitlement is exactly what made
 * production resurrect weekly-exhausted and arrears keys as "positive
 * entitlement" while the inference endpoint refused them. Anything else the
 * Provider may add is not a claim this adapter can justify, so it is skipped
 * rather than guessed at.
 */
function isCapacityBearingLimit(entry: ZaiLimit): boolean {
  return entry.type === CREDIT_LIMIT || entry.type === TOKENS_LIMIT
}

/**
 * Parse the bounded, documented portion of the Zhipu coding-plan response.
 *
 * Every capacity-bearing entry becomes its own reading, so the shared
 * reconciliation sees each window the Provider named and a consumed entry can
 * dominate an unconsumed one regardless of the order the Provider used — the
 * arrears body puts the unconsumed credit window first, and a single-entry
 * reading would repeat the production resurrection on exactly that body. An
 * envelope that parses but yields no capacity-bearing entry is an honest
 * empty reading, not a parse failure: the tool-call quota alone says nothing
 * about chat capacity.
 */
export function zaiUsageReadings(body: unknown): readonly UsageReading[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return []
  const root = body as Record<string, unknown>
  if (finiteNumber(root.code) !== 200) return []
  if (typeof root.data !== 'object' || root.data === null || Array.isArray(root.data)) return []
  const limits = (root.data as Record<string, unknown>).limits
  if (!Array.isArray(limits)) return []

  const entries = limits.filter(
    (value): value is ZaiLimit => typeof value === 'object' && value !== null && !Array.isArray(value),
  )
  const readings: UsageReading[] = []
  for (const entry of entries) {
    if (!isCapacityBearingLimit(entry)) continue
    const percent = remainingPercent(entry)
    if (percent === null) continue
    const credit = entry.type === CREDIT_LIMIT
    const window = entry.type.toLowerCase()
    readings.push({
      unit: typeof entry.unit === 'string' ? entry.unit : window,
      balance: credit ? finiteNumber(entry.remaining) : null,
      // `usage` is the window's total and `currentValue` how much of it is
      // spent. `number` is not a quota size — on the real bodies it is a plan
      // tier count — so it never becomes a fact.
      used: finiteNumber(entry.currentValue),
      limit: finiteNumber(entry.usage),
      remainingPercent: percent,
      plan: 'GLM Coding Plan',
      resetAt: resetAt(entry.nextResetTime),
      scope: { kind: 'key', keyId: '' },
      keyId: null,
      confidence: 'confirmed',
      diagnostics: {
        source: 'zai-usage-adapter',
        kind: credit ? 'credit' : 'subscription',
        limitingWindow: window,
      },
    })
  }
  return readings
}

export function zaiCapacityEvidenceOf(
  reading: UsageReading,
  keyId: string,
  observedAt: Date,
): CapacityEvidence {
  const remaining = reading.remainingPercent
  const authoritative = reading.confidence === 'confirmed' && remaining !== null
  const available = authoritative && remaining > 0
  const exhausted = authoritative && remaining <= 0
  // A credit window reporting zero is the billing condition the inference
  // endpoint spells `1113`; a token window at zero is the plan's usage window.
  // Both reconcile to durable exhaustion, but the reason names which one, so
  // the Owner sees arrears and window limits as themselves.
  const credit = reading.diagnostics.kind === 'credit'
  const reason = available ? 'positive_entitlement'
    : exhausted ? credit ? 'credit_exhausted' : 'window_exhausted'
    : 'unknown'
  const limitingWindow = typeof reading.diagnostics.limitingWindow === 'string'
    ? reading.diagnostics.limitingWindow.slice(0, 64)
    : undefined
  const diagnostics: ProviderDiagnostics = {
    classification: reason,
    capacityScope: 'key',
    ...(limitingWindow === undefined ? {} : { limitingWindow }),
    ...(reading.resetAt === null ? {} : { recheckAt: reading.resetAt.toISOString() }),
    ...(remaining === null ? {} : { remainingPercent: remaining }),
    ...(reading.used === null ? {} : { used: reading.used }),
    ...(reading.limit === null ? {} : { limit: reading.limit }),
  }

  return {
    availability: available ? 'available' : exhausted ? 'exhausted' : 'unknown',
    authority: authoritative ? 'authoritative' : 'unknown',
    scope: { kind: 'key', keyId },
    reason,
    observedAt,
    freshUntil: new Date(observedAt.getTime() + EVIDENCE_FRESHNESS_MS),
    recheckAt: reading.resetAt,
    facts: {
      ...(remaining === null ? {} : { remainingPercent: remaining }),
      ...(reading.used === null ? {} : { used: reading.used }),
      ...(reading.limit === null ? {} : { limit: reading.limit }),
      unit: reading.unit,
    },
    diagnostics,
  }
}

export function createZaiUsageAdapter(options: ZaiUsageAdapterOptions = {}): UsageAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch
  return {
    visibility: 'authoritative',
    capacityEvidenceOf: zaiCapacityEvidenceOf,
    async read(request: UsageAdapterRequest): Promise<UsagePollResult> {
      if (request.signal?.aborted === true) {
        return { ok: false, failure: { code: 'upstream_unreachable', message: 'the poll was cancelled' } }
      }
      let response: Response
      try {
        response = await fetchImpl(`${entitlementHost(request.baseUrl)}${QUOTA_PATH}`, {
          method: 'GET',
          headers: { authorization: `Bearer ${request.upstreamKey}`, accept: 'application/json' },
          redirect: 'manual',
          ...(request.signal == null ? {} : { signal: request.signal }),
        })
      } catch {
        return { ok: false, failure: { code: 'upstream_unreachable', message: 'Z.ai quota endpoint could not be reached' } }
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined)
        return { ok: false, failure: { code: 'upstream_refused', status: response.status, message: `Z.ai quota endpoint refused (HTTP ${response.status})` } }
      }
      let body: unknown
      try {
        body = await response.json()
      } catch {
        return { ok: false, failure: { code: 'unparseable_response', message: 'Z.ai quota endpoint returned an unparseable body' } }
      }
      const readings = zaiUsageReadings(body)
      // A valid key without Coding Plan returns a provider code 500 in a 2xx
      // envelope. Credit is console-only, so an empty successful reading is
      // the honest result instead of inventing a zero balance. The same honesty
      // applies to a code-200 envelope whose limits are all tool-call quotas:
      // the shape matched, there is just nothing that speaks for chat capacity.
      if (readings.length === 0 && typeof body === 'object' && body !== null) {
        const root = body as Record<string, unknown>
        if (root.success === false && finiteNumber(root.code) === 500) return { ok: true, readings: [] }
        if (root.success === true && finiteNumber(root.code) === 200) return { ok: true, readings: [] }
      }
      if (readings.length === 0) {
        return { ok: false, failure: { code: 'unparseable_response', message: 'Z.ai quota response did not match the expected shape' } }
      }
      return { ok: true, readings }
    },
  }
}
