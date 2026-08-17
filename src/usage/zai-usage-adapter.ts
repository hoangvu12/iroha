import type { CapacityEvidence, ProviderDiagnostics } from '../providers/provider-evidence.ts'
import type { UsageAdapter, UsageAdapterRequest, UsagePollResult, UsageReading } from './adapter.ts'

const QUOTA_PATH = '/api/monitor/usage/quota/limit'
const EVIDENCE_FRESHNESS_MS = 60_000

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

/** Parse the bounded, documented portion of the Zhipu coding-plan response. */
export function zaiUsageReadings(body: unknown): readonly UsageReading[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return []
  const root = body as Record<string, unknown>
  if (finiteNumber(root.code) !== 200) return []
  if (typeof root.data !== 'object' || root.data === null || Array.isArray(root.data)) return []
  const limits = (root.data as Record<string, unknown>).limits
  if (!Array.isArray(limits) || limits.length === 0) return []

  const entries = limits.filter(
    (value): value is ZaiLimit => typeof value === 'object' && value !== null && !Array.isArray(value),
  )
  const primary = entries.find((entry) => entry.type === 'TIME_LIMIT') ?? entries[0]
  if (primary === undefined) return []
  const percent = remainingPercent(primary)
  if (percent === null) return []

  const total = finiteNumber(primary.usage) ?? finiteNumber(primary.number)
  const used = finiteNumber(primary.currentValue)
  const window = typeof primary.type === 'string' && primary.type.length <= 64
    ? primary.type.toLowerCase()
    : 'unknown'

  return [{
    unit: typeof primary.unit === 'string' ? primary.unit : 'requests',
    balance: null,
    used,
    limit: total,
    remainingPercent: percent,
    plan: 'GLM Coding Plan',
    resetAt: resetAt(primary.nextResetTime),
    scope: { kind: 'key', keyId: '' },
    keyId: null,
    confidence: 'confirmed',
    diagnostics: {
      source: 'zai-usage-adapter',
      kind: 'subscription',
      limitingWindow: window,
    },
  }]
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
  const reason = available ? 'positive_entitlement' : exhausted ? 'window_exhausted' : 'unknown'
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
      // the honest result instead of inventing a zero balance.
      if (readings.length === 0 && typeof body === 'object' && body !== null) {
        const root = body as Record<string, unknown>
        if (root.success === false && finiteNumber(root.code) === 500) return { ok: true, readings: [] }
      }
      if (readings.length === 0) {
        return { ok: false, failure: { code: 'unparseable_response', message: 'Z.ai quota response did not match the expected shape' } }
      }
      return { ok: true, readings }
    },
  }
}
