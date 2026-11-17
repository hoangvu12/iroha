import type { CapacityEvidence, ProviderDiagnostics } from '../providers/provider-evidence.ts'
import type { UsageAdapter, UsageAdapterRequest, UsagePollResult, UsageReading } from './adapter.ts'

/**
 * The entitlement surface of a DeepAI Code gateway.
 *
 * DeepAI Code meters its frontier models in Theos, and a gateway that fronts one
 * (deepai-proxy) answers `GET /theos` for the credential the caller presents. So
 * this adapter reads the allowance of one Upstream Key, which is exactly what
 * Capacity Scope "key" needs to retire a key whose Theos ran out and route the
 * next Request to another.
 */
const ENTITLEMENT_PATH = '/theos'
const EVIDENCE_FRESHNESS_MS = 60_000

export interface DeepaiUsageAdapterOptions {
  readonly fetch?: typeof fetch
  readonly now?: () => Date
}

/** The entitlement body a DeepAI gateway answers with. */
interface DeepaiEntitlement {
  readonly enabled?: unknown
  readonly balance?: unknown
  readonly granted?: unknown
  readonly refresh_at?: unknown
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  // The gateway reports the amounts as fixed-precision strings ("50.00000"), so a
  // number-shaped string is the normal case rather than an odd one.
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

function resetAt(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

/**
 * The entitlement URL for a Provider's base URL.
 *
 * The Provider's base URL is the inference root (`…/v1` for a deepai-proxy
 * deployment), and the gateway serves the allowance under it. Resolving the path
 * against the base URL rather than the origin keeps the adapter working for a
 * gateway mounted on a sub-path, and keeps the Provider's own URL the single
 * place the endpoint is configured.
 */
export function deepaiEntitlementUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${ENTITLEMENT_PATH}`
}

/**
 * Parse the bounded, documented portion of the entitlement body.
 *
 * `balance` is what is left of the day's grant and `granted` is the size of the
 * grant itself, so the reading carries both the remaining balance and the
 * window it belongs to. A body without both numbers is not a reading: an
 * unreadable allowance stays unknown rather than collapsing into zero.
 */
export function deepaiUsageReadings(body: unknown): readonly UsageReading[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return []
  const root = body as Record<string, unknown>
  const entitlement = root as DeepaiEntitlement
  const granted = finiteNumber(entitlement.granted)
  const balance = finiteNumber(entitlement.balance)
  if (granted === null || balance === null) return []

  // A disabled entitlement has no allowance to spend, whatever the numbers say.
  const enabled = entitlement.enabled !== false
  const remaining = enabled ? Math.max(0, balance) : 0
  const limit = enabled ? Math.max(0, granted) : 0
  const percent = limit > 0 ? clampPercent((remaining / limit) * 100) : null

  return [
    {
      unit: 'Theos',
      balance: remaining,
      used: limit > 0 ? Math.max(0, limit - remaining) : null,
      limit: limit > 0 ? limit : null,
      remainingPercent: percent,
      plan: 'DeepAI Code daily Theos',
      resetAt: resetAt(entitlement.refresh_at),
      scope: { kind: 'key', keyId: '' },
      keyId: null,
      confidence: 'confirmed',
      diagnostics: {
        source: 'deepai-usage-adapter',
        kind: 'credit',
        ...(enabled ? {} : { classification: 'entitlement_disabled' }),
      },
    },
  ]
}

/**
 * Converts a reading into shared capacity evidence.
 *
 * A confirmed zero is proof of absence and retires the key until the grant
 * resets; the reset time rides along so the scheduler rechecks when the day's
 * Theos come back rather than on its own cadence.
 */
export function deepaiCapacityEvidenceOf(
  reading: UsageReading,
  keyId: string,
  observedAt: Date,
): CapacityEvidence {
  const balance = reading.balance
  const authoritative = reading.confidence === 'confirmed' && balance !== null
  const available = authoritative && balance > 0
  const exhausted = authoritative && balance <= 0
  const reason = available ? 'positive_entitlement' : exhausted ? 'credit_exhausted' : 'unknown'
  const diagnostics: ProviderDiagnostics = {
    classification: reason,
    capacityScope: 'key',
    ...(reading.resetAt === null ? {} : { recheckAt: reading.resetAt.toISOString() }),
    ...(reading.remainingPercent === null ? {} : { remainingPercent: reading.remainingPercent }),
    ...(reading.used === null ? {} : { used: reading.used }),
    ...(reading.limit === null ? {} : { limit: reading.limit }),
    ...(reading.balance === null ? {} : { remaining: reading.balance }),
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
      ...(reading.balance === null ? {} : { remaining: reading.balance }),
      ...(reading.remainingPercent === null ? {} : { remainingPercent: reading.remainingPercent }),
      ...(reading.used === null ? {} : { used: reading.used }),
      ...(reading.limit === null ? {} : { limit: reading.limit }),
      unit: reading.unit,
    },
    diagnostics,
  }
}

export function createDeepaiUsageAdapter(options: DeepaiUsageAdapterOptions = {}): UsageAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch
  return {
    visibility: 'authoritative',
    capacityEvidenceOf: deepaiCapacityEvidenceOf,
    async read(request: UsageAdapterRequest): Promise<UsagePollResult> {
      if (request.signal?.aborted === true) {
        return { ok: false, failure: { code: 'upstream_unreachable', message: 'the poll was cancelled' } }
      }
      let response: Response
      try {
        response = await fetchImpl(deepaiEntitlementUrl(request.baseUrl), {
          method: 'GET',
          headers: { authorization: `Bearer ${request.upstreamKey}`, accept: 'application/json' },
          redirect: 'manual',
          ...(request.signal == null ? {} : { signal: request.signal }),
        })
      } catch {
        return {
          ok: false,
          failure: { code: 'upstream_unreachable', message: 'DeepAI entitlement endpoint could not be reached' },
        }
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined)
        return {
          ok: false,
          failure: { code: 'upstream_refused', status: response.status, message: `DeepAI entitlement endpoint refused (HTTP ${response.status})` },
        }
      }
      let body: unknown
      try {
        body = await response.json()
      } catch {
        return {
          ok: false,
          failure: { code: 'unparseable_response', message: 'DeepAI entitlement endpoint returned an unparseable body' },
        }
      }
      const readings = deepaiUsageReadings(body)
      if (readings.length === 0) {
        return {
          ok: false,
          failure: { code: 'unparseable_response', message: 'DeepAI entitlement response did not match the expected shape' },
        }
      }
      return { ok: true, readings }
    },
  }
}
