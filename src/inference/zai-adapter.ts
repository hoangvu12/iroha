import type {
  InferenceAdapter,
  InferenceFailureClassification,
  InferenceFailureContext,
  InferenceForwardResult,
} from './adapter.ts'
import {
  createGenericInferenceAdapter,
  type GenericInferenceAdapterOptions,
} from './generic-adapter.ts'
import type { CapacityEvidence, ProviderDiagnostics } from '../providers/provider-evidence.ts'

/**
 * The Z.ai (Zhipu / BigModel) Inference Adapter: typed failure classification
 * for Z.ai's documented error envelope, OpenAI-shaped pass-through otherwise.
 *
 * Z.ai speaks an OpenAI-compatible Chat Completions surface at
 * `https://api.z.ai/api/coding/paas/v4` (the mainland `open.bigmodel.cn`
 * mirror shares the same error envelope). The error body carries a numeric
 * `code` field documented at `https://docs.z.ai/api-reference/api-code.md`
 * that distinguishes the failure shape generic HTTP status cannot:
 *
 *   - 1113 (HTTP 429): insufficient balance / no resource package
 *   - 1301 (HTTP 400): content-policy rejection
 *   - 1302 (HTTP 429): transient rate limit
 *   - 1308, 1310, 1316–1321 (HTTP 429): 5-hour / 7-day window exhaustion.
 *     The documented message mentions `next_flush_time`; when the upstream
 *     additionally emits a structured field, the adapter accepts it.
 *   - 1309 (HTTP 429): coding plan expired
 *   - 1311 (HTTP 429): plan does not include the requested model
 *   - 1313 (HTTP 429): fair-use policy throttling
 *
 * The adapter emits key-scoped provisional Capacity Evidence for the
 * capacity-bearing codes so the shared reconciliation module can durably
 * demote exhausted keys without a manual probe. Unrecognized envelopes fall
 * through to the generic adapter's status-based classification rather than
 * guessing; an Owner Refresh re-probes authentication independently.
 */
interface ZaiErrorEnvelope {
  readonly code?: string
  readonly type?: string
}

const INSUFFICIENT_BALANCE = '1113'
const POLICY_BLOCKED = '1300'
const CONTENT_POLICY = '1301'
const RATE_LIMIT = '1302'
const DAILY_LIMIT = '1304'
const SERVICE_OVERLOADED = '1305'
const FIVE_HOUR_LIMIT = '1308'
const PLAN_EXPIRED = '1309'
const WEEKLY_LIMIT = '1310'
const PLAN_MISSING_MODEL = '1311'
const FAIR_USE = '1313'
const ENTERPRISE_PLAN_EXPIRED = '1314'
const WRONG_KEY_PRODUCT = '1315'
const FIVE_HOUR_WINDOW_LIMITS = new Set(['1316', '1318', '1320'])
const SEVEN_DAY_WINDOW_LIMITS = new Set(['1317', '1319', '1321'])

const PROVISIONAL_EVIDENCE_FRESHNESS_MS = 60_000

/** Z.ai text inference stays OpenAI-compatible; only failure meaning varies. */
export function createZaiInferenceAdapter(
  options: GenericInferenceAdapterOptions = {},
): InferenceAdapter {
  const generic = createGenericInferenceAdapter(options)
  return {
    capabilities: generic.capabilities,
    forward: generic.forward,
    classifyFailure(
      result: InferenceForwardResult,
      context?: InferenceFailureContext,
    ): InferenceFailureClassification {
      const genericClassification = generic.classifyFailure(result)
      const envelope = zaiErrorEnvelope(result)
      if (envelope === null) return genericClassification

      // 1301 is content-policy rejection: a per-request denial, not capacity.
      if (
        (envelope.code === POLICY_BLOCKED || envelope.code === CONTENT_POLICY) &&
        result.status === 400
      ) {
        return {
          ...genericClassification,
          diagnostics: zaiDiagnostics({
            status: result.status,
            providerCode: envelope.code,
            providerType: envelope.type ?? 'content_policy',
            classification: 'request_rejected',
            capacityScope: 'unknown',
          }, context),
        }
      }

      // 1311 is the upstream refusing because the plan tier does not include
      // the model. Retrying with the same key is a stop; an alternate key on
      // a different plan cannot help either. `request_rejected` keyed on
      // `connection_model` so the routing layer knows the limit is on the
      // model, not the credential.
      if (envelope.code === PLAN_MISSING_MODEL && result.status === 429) {
        return {
          ...genericClassification,
          kind: 'request_rejected',
          capacityScope: 'connection_model',
          retryAction: 'stop',
          diagnostics: zaiDiagnostics({
            status: result.status,
            providerCode: envelope.code,
            providerType: envelope.type ?? 'plan_missing_model',
            classification: 'unsupported',
            capacityScope: 'connection_model',
          }, context),
        }
      }

      // 1113 (insufficient balance) and 1309 (plan expired) are billing
      // conditions. The reconciliation module treats a key-scoped
      // `payment_required` reading as durable exhaustion.
      if (
        (envelope.code === INSUFFICIENT_BALANCE ||
          envelope.code === PLAN_EXPIRED ||
          envelope.code === ENTERPRISE_PLAN_EXPIRED) &&
        result.status === 429 &&
        context !== undefined
      ) {
        return {
          ...genericClassification,
          kind: 'payment_required',
          capacityScope: 'key',
          diagnostics: zaiDiagnostics({
            status: result.status,
            providerCode: envelope.code,
            providerType: envelope.type ?? 'payment_required',
            classification: 'payment_required',
            capacityScope: 'key',
          }, context),
          capacityEvidence: zaiCapacityEvidence({
            availability: 'exhausted',
            authority: 'provisional',
            reason: 'credit_exhausted',
            observedAt: context.observedAt,
            recheckAt: null,
            code: envelope.code,
            type: envelope.type,
            status: result.status,
            window: null,
          }, context),
        }
      }

      // 1315 means the credential belongs to a different Z.ai product. It is
      // accepted as a key, but unusable on this Provider surface; another key
      // may work, while retrying this one cannot.
      if (envelope.code === WRONG_KEY_PRODUCT && result.status === 429) {
        return {
          ...genericClassification,
          kind: 'authentication_rejected',
          capacityScope: 'key',
          retryAction: 'try_alternate',
          diagnostics: zaiDiagnostics({
            status: result.status,
            providerCode: envelope.code,
            providerType: envelope.type ?? 'wrong_key_product',
            classification: 'authentication_rejected',
            capacityScope: 'key',
          }, context),
        }
      }

      // 1305 is explicitly service overload, not a depleted key or account.
      // Keep it Provider-scoped and transient; no durable Capacity Evidence
      // is emitted because rotating credentials cannot repair an overload.
      if (envelope.code === SERVICE_OVERLOADED && result.status === 429) {
        return {
          ...genericClassification,
          kind: 'capacity_limited',
          capacityScope: 'provider',
          retryAction: 'retry_same',
          diagnostics: zaiDiagnostics({
            status: result.status,
            providerCode: envelope.code,
            providerType: envelope.type ?? 'service_overloaded',
            classification: 'capacity_limited',
            capacityScope: 'provider',
          }, context),
        }
      }

      // The remaining capacity codes all map to key-scoped
      // `capacity_limited` evidence; only the `recheckAt` from
      // `next_flush_time` differentiates them from generic 429 throttling.
      if (
        envelope.code === undefined ||
        !isCapacityLimitedCode(envelope.code) ||
        result.status !== 429 ||
        context === undefined
      ) {
        // Surface the structured envelope in diagnostics without asserting
        // capacity when the code is not capacity-bearing or context is
        // absent. This keeps 401/403 auth envelopes informative without
        // overclaiming.
        if (envelope.code !== undefined) {
          return {
            ...genericClassification,
            diagnostics: zaiDiagnostics({
              status: result.status,
              ...(envelope.code === undefined ? {} : { providerCode: envelope.code }),
              ...(envelope.type === undefined ? {} : { providerType: envelope.type }),
              classification: genericClassification.kind,
              capacityScope: genericClassification.capacityScope,
            }, context),
          }
        }
        return genericClassification
      }

      const window = windowForCode(envelope.code)
      const recheckAt = result.kind === 'buffered' ? parseRecheckTime(result.body) : null
      const observedAt = context.observedAt
      const freshUntil = new Date(observedAt.getTime() + PROVISIONAL_EVIDENCE_FRESHNESS_MS)

      return {
        ...genericClassification,
        capacityScope: 'key',
        diagnostics: zaiDiagnostics({
          status: result.status,
          providerCode: envelope.code,
          ...(envelope.type === undefined ? {} : { providerType: envelope.type }),
          classification: 'capacity_limited',
          capacityScope: 'key',
          ...(window === null ? {} : { limitingWindow: window }),
          ...(recheckAt === null ? {} : { recheckAt: recheckAt.toISOString() }),
        }, context),
        capacityEvidence: zaiCapacityEvidence({
          availability: 'temporarily_limited',
          authority: 'provisional',
          reason: 'temporarily_limited',
          observedAt,
          recheckAt,
          code: envelope.code,
          type: envelope.type,
          status: result.status,
          window,
        }, context, freshUntil),
      }
    },
  }
}

/** Returns the canonical Z.ai five-hour / seven-day window label for a code, or null when not a windowed limit. */
function windowForCode(code: string): string | null {
  if (code === DAILY_LIMIT) return 'daily'
  if (code === FIVE_HOUR_LIMIT) return 'five_hour'
  if (code === WEEKLY_LIMIT) return 'weekly'
  if (FIVE_HOUR_WINDOW_LIMITS.has(code)) return 'five_hour'
  if (SEVEN_DAY_WINDOW_LIMITS.has(code)) return 'seven_day'
  return null
}

function isCapacityLimitedCode(code: string): boolean {
  return (
    code === RATE_LIMIT ||
    code === DAILY_LIMIT ||
    code === FIVE_HOUR_LIMIT ||
    code === WEEKLY_LIMIT ||
    code === FAIR_USE ||
    FIVE_HOUR_WINDOW_LIMITS.has(code) ||
    SEVEN_DAY_WINDOW_LIMITS.has(code)
  )
}

/**
 * Defensively reads a structured `next_flush_time` from a Z.ai 429 body.
 * Official docs guarantee only `error.code` and `error.message`, with the
 * reset value interpolated into the human-readable message. We deliberately
 * do not parse that localized message. If a structured extension is present,
 * accept an ISO string or Unix-millisecond number; otherwise report no reset.
 */
function parseRecheckTime(body: string): Date | null {
  if (body === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const error = parsed.error
  if (!isRecord(error)) return null
  const value = error.next_flush_time
  if (typeof value === 'string' && value.length > 0) {
    const date = new Date(value)
    if (Number.isFinite(date.getTime()) && date.getTime() > 0) return date
    return null
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value)
  }
  return null
}

/** Parses only the stable Z.ai error envelope; messages stay behind. */
function zaiErrorEnvelope(result: InferenceForwardResult): ZaiErrorEnvelope | null {
  if (result.kind !== 'buffered' || result.body === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(result.body)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const error = parsed.error
  if (!isRecord(error)) return null
  const code = boundedCode(error.upstream_code ?? error.code)
  const type = boundedIdentifier(error.upstream_type ?? error.type)
  if (code === undefined && type === undefined) return null
  return {
    ...(code === undefined ? {} : { code }),
    ...(type === undefined ? {} : { type }),
  }
}

function boundedCode(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 99_999) {
    return String(Math.trunc(value))
  }
  if (typeof value === 'string' && value.length > 0 && value.length <= 16) {
    return value
  }
  return undefined
}

function boundedIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : undefined
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Builds the bounded Provider Diagnostics the shared evidence allow-list
 * accepts. `classification` and `capacityScope` are stringified enums so the
 * downstream allow-list pass-through does not reject them.
 */
function zaiDiagnostics(
  fields: Readonly<{
    status: number
    providerCode?: string
    providerType?: string
    classification: NonNullable<ProviderDiagnostics['classification']>
    capacityScope: NonNullable<ProviderDiagnostics['capacityScope']>
    limitingWindow?: string
    recheckAt?: string
  }>,
  context: InferenceFailureContext | undefined,
): ProviderDiagnostics {
  const observedAt = context?.observedAt ?? new Date()
  const diagnostics: ProviderDiagnostics = {
    status: fields.status,
    ...(fields.providerCode === undefined ? {} : { providerCode: fields.providerCode }),
    ...(fields.providerType === undefined ? {} : { providerType: fields.providerType }),
    classification: fields.classification,
    capacityScope: fields.capacityScope,
    ...(fields.limitingWindow === undefined ? {} : { limitingWindow: fields.limitingWindow }),
    ...(fields.recheckAt === undefined ? {} : { recheckAt: fields.recheckAt }),
    evidenceAuthority: 'provisional',
    evidenceObservedAt: observedAt.toISOString(),
    evidenceFreshUntil: observedAt.toISOString(),
  }
  return diagnostics
}

/**
 * Wraps a Z.ai 429 evidence reading in the same CapacityEvidence envelope
 * the MiniMax adapter emits, so the reconciliation module handles both
 * providers uniformly. `freshUntil` is a parameter so the caller can pick
 * the right freshness floor for each code (e.g. 1113 / 1309 keep the bare
 * observation time).
 */
function zaiCapacityEvidence(
  reading: Readonly<{
    availability: 'exhausted' | 'temporarily_limited'
    authority: 'provisional'
    reason: 'credit_exhausted' | 'temporarily_limited'
    observedAt: Date
    recheckAt: Date | null
    code: string
    type: string | undefined
    status: number
    window: string | null
  }>,
  context: InferenceFailureContext | undefined,
  freshUntil?: Date,
): CapacityEvidence {
  const inferredFreshUntil = freshUntil ?? reading.observedAt
  return {
    availability: reading.availability,
    authority: reading.authority,
    scope: { kind: 'key', keyId: context?.keyId ?? 'unknown' },
    reason: reading.reason,
    observedAt: reading.observedAt,
    freshUntil: inferredFreshUntil,
    recheckAt: reading.recheckAt,
    facts: {},
    diagnostics: {
      status: reading.status,
      providerCode: reading.code,
      ...(reading.type === undefined ? {} : { providerType: reading.type }),
      classification: reading.reason,
      capacityScope: 'key',
      ...(reading.window === null ? {} : { limitingWindow: reading.window }),
      ...(reading.recheckAt === null ? {} : { recheckAt: reading.recheckAt.toISOString() }),
      evidenceAuthority: reading.authority,
      evidenceObservedAt: reading.observedAt.toISOString(),
      evidenceFreshUntil: inferredFreshUntil.toISOString(),
    },
  }
}
