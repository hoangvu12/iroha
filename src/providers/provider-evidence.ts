/** A Provider-independent description of the resource capacity applies to. */
export type CapacityScope =
  | { readonly kind: 'key'; readonly keyId: string }
  | { readonly kind: 'account'; readonly accountId: string }
  | { readonly kind: 'connection_model'; readonly model: string }
  | { readonly kind: 'provider' }
  | { readonly kind: 'unknown' }

export type CapacityAvailability = 'available' | 'exhausted' | 'temporarily_limited' | 'unknown'
export type EvidenceAuthority = 'authoritative' | 'provisional' | 'unknown'
export type CapacityReason =
  | 'positive_entitlement'
  | 'credit_exhausted'
  | 'window_exhausted'
  | 'temporarily_limited'
  | 'unsupported'
  | 'unknown'

/** Numeric facts which are safe to retain and useful during reconciliation. */
export interface CapacityFacts {
  readonly remaining?: number
  readonly remainingPercent?: number
  readonly used?: number
  readonly limit?: number
  readonly unit?: string
}

/**
 * The complete allow-list of Provider response facts that may cross into
 * persistence. In particular there is deliberately no message, body, header,
 * prompt, or completion field.
 */
export interface ProviderDiagnostics {
  readonly status?: number
  readonly providerCode?: string
  readonly providerType?: string
  readonly classification?: string
  readonly capacityScope?: CapacityScope['kind']
  readonly limitingWindow?: string
  readonly retryAfterSeconds?: number
  readonly retryAt?: string
  readonly recheckAt?: string
  readonly evidenceAuthority?: EvidenceAuthority
  readonly evidenceObservedAt?: string
  readonly evidenceFreshUntil?: string
  readonly remaining?: number
  readonly remainingPercent?: number
  readonly used?: number
  readonly limit?: number
}

/** A normalized capacity observation emitted by an Inference or Usage Adapter. */
export interface CapacityEvidence {
  readonly availability: CapacityAvailability
  readonly authority: EvidenceAuthority
  readonly scope: CapacityScope
  readonly reason: CapacityReason
  readonly observedAt: Date
  readonly freshUntil: Date
  readonly recheckAt: Date | null
  readonly facts: CapacityFacts
  readonly diagnostics: ProviderDiagnostics
}

export type CredentialEvidenceVerdict = 'authenticated' | 'rejected' | 'inconclusive'

/** Authentication evidence never implies capacity or Routing Eligibility. */
export interface CredentialEvidence {
  readonly verdict: CredentialEvidenceVerdict
  readonly reason: string | null
}

const MAX_DIAGNOSTIC_TEXT = 64
const DIAGNOSTIC_TEXT_FIELDS = [
  'providerCode',
  'providerType',
  'classification',
  'capacityScope',
  'limitingWindow',
  'retryAt',
  'recheckAt',
  'evidenceAuthority',
  'evidenceObservedAt',
  'evidenceFreshUntil',
] as const
const DIAGNOSTIC_NUMBER_FIELDS = [
  'status',
  'retryAfterSeconds',
  'remaining',
  'remainingPercent',
  'used',
  'limit',
] as const

/**
 * Copies diagnostics from an untrusted adapter value by allow-list. Unknown,
 * malformed, and non-finite values are discarded; strings are bounded.
 */
export function providerDiagnosticsOf(input: unknown): ProviderDiagnostics {
  if (!isRecord(input)) return {}

  const diagnostics: Record<string, string | number> = {}
  for (const field of DIAGNOSTIC_TEXT_FIELDS) {
    const value = input[field]
    if (typeof value === 'string' && value.length > 0) {
      diagnostics[field] = value.slice(0, MAX_DIAGNOSTIC_TEXT)
    }
  }
  for (const field of DIAGNOSTIC_NUMBER_FIELDS) {
    const value = input[field]
    if (typeof value === 'number' && Number.isFinite(value)) diagnostics[field] = value
  }

  return diagnostics
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
