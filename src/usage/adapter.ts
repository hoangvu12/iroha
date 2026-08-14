/**
 * The Usage Adapter contract: typed knowledge of how to read authoritative
 * Provider entitlement when the Provider exposes a documented API. The generic
 * form observes inference outcomes without claiming an authoritative remaining
 * balance; typed adapters normalize credit balance, coding-plan windows,
 * subscription usage, or any other provider-specific entitlement shape into
 * the same record the Owner UI reads.
 *
 * The contract never claims authority it cannot prove: an unknown remaining
 * balance is reported as unknown rather than silently turning into zero.
 */

/** What kind of entitlement a Usage Adapter can read. */
export type UsageVisibility = 'reactive_only' | 'authoritative'

/**
 * Where the entitlement applies. The Capacity Scope mirrors the one Key Health
 * uses, so a known scope lets the Owner map an authoritative reading back to
 * the keys or accounts it should reactivate.
 */
export type UsageCapacityScope =
  | { readonly kind: 'key'; readonly keyId: string }
  | { readonly kind: 'account'; readonly accountId: string }
  | { readonly kind: 'connection_model'; readonly model: string }
  | { readonly kind: 'provider' }
  | { readonly kind: 'unknown' }

/**
 * A normalized entitlement reading. `balance` and `used` are nullable on
 * purpose: a credit adapter knows balance; a coding-plan adapter knows used
 * and a window; both know reset time.
 *
 * `confidence` is the adapter's own honest signal: `confirmed` means a real
 * Provider value, `unknown` means the adapter cannot read authority and is
 * reporting a structured guess or an absence. The UI never turns unknown into
 * zero.
 */
export interface UsageReading {
  /** A human-meaningful units label (USD, credits, requests, tokens, …). */
  readonly unit: string
  /**
   * Remaining balance. `null` when the adapter cannot read it. A confirmed zero
   * is `0`; missing authority is `null` and never collapses into zero.
   */
  readonly balance: number | null
  /** Used portion in the current window, when known. */
  readonly used: number | null
  /** Total allowance for the current window, when known. */
  readonly limit: number | null
  /**
   * Percent remaining in the current window (0–100). Set by adapters whose
   * upstream reports the window as a percentage; `null` otherwise. The UI
   * uses this for the subscription "X% left" headline rather than the absolute
   * `used / limit` fraction.
   */
  readonly remainingPercent: number | null
  /**
   * A short plan label the adapter wants the UI to render alongside the
   * percent, e.g. the model name from `model_remains[0].model` or a hard-coded
   * `"Coding Plan"`. `null` when the adapter has nothing meaningful to surface.
   */
  readonly plan: string | null
  /** When the current window resets. `null` when the adapter cannot read it. */
  readonly resetAt: Date | null
  /** Where this reading applies; `unknown` is honest, never a guess. */
  readonly scope: UsageCapacityScope
  /**
   * The Upstream Key the service used to fetch this reading. `null` for a
   * reading that is not tied to a specific key (e.g. a legacy snapshot
   * written before per-key polling landed, or a reactive-only reading the
   * service cannot attribute to a key). The adapter never sets this; the
   * `UsageService` does, at the moment it knows which key the poll ran
   * through. The `scope` field above describes the *entitlement* (account,
   * model, provider); `keyId` describes the *transport* and decides which
   * row in the Upstream Keys table the reading belongs in.
   */
  readonly keyId: string | null
  /** Whether the adapter stands behind this reading. */
  readonly confidence: 'confirmed' | 'unknown'
  /**
   * Raw provider diagnostic boundaries the adapter passed through (status,
   * upstream message code, window name, …). Kept structurally so a failure
   * reason never echoes a secret.
   */
  readonly diagnostics: Readonly<Record<string, unknown>>
}

/**
 * What a single poll returns. The service persists the success and records the
 * failure independently. A successful poll returns a list of normalized
 * readings — per-account adapters emit one, per-model adapters (e.g. MiniMax)
 * emit one per model the upstream names. The list is empty when the adapter
 * could not produce a structured reading.
 */
export type UsagePollResult =
  | { readonly ok: true; readonly readings: readonly UsageReading[] }
  | { readonly ok: false; readonly failure: UsageFailure }

/**
 * Why a poll could not read a reading. Codes are structural so the UI can
 * show the latest error without echoing any upstream text that might contain
 * a secret.
 */
export type UsageFailure =
  | {
      readonly code: 'upstream_unreachable'
      readonly message: string
    }
  | {
      readonly code: 'upstream_refused'
      readonly status: number
      readonly message: string
    }
  | {
      readonly code: 'unparseable_response'
      readonly message: string
    }
  | {
      readonly code: 'no_eligible_key'
    }
  | {
      readonly code: 'stored_key_unreadable'
    }
  | {
      readonly code: 'rate_limited'
      readonly retryAfterSeconds: number
    }

/**
 * The inputs a Usage Adapter needs. The service decrypts the Upstream Key for
 * the call's duration; the adapter never holds it across polls.
 */
export interface UsageAdapterRequest {
  readonly baseUrl: string
  readonly allowInsecureHttp: boolean
  readonly upstreamKey: string
  /**
   * A short-lived token carried through cancellation; tests use it to abort a
   * hung poll, the runtime hands it through from any active call.
   */
  readonly signal?: AbortSignal | null
}

/**
 * The Usage Adapter seam. Typed adapters declare their visibility and read
 * capacity; the service persists the outcome, the polling scheduler drives it
 * at its cadence, and Key Health reads back the result to drive authoritative
 * recovery when it is available.
 */
export interface UsageAdapter {
  readonly visibility: UsageVisibility
  read(request: UsageAdapterRequest): Promise<UsagePollResult>
}

/**
 * Evidence that capacity has recovered, drawn from a successful authoritative
 * Usage Adapter reading. The Owner can trust this without paying for an
 * inference probe.
 */
export interface UsageRecoveryEvidence {
  /** Whether the adapter is authoritative; reactive-only evidence never reactivates. */
  readonly authoritative: boolean
  /**
   * The capacity the evidence speaks to. `null` means a Provider-wide reset;
   * `unknown` means the adapter could not determine where it applies.
   */
  readonly scope: UsageReading['scope']
  /** When the reading was taken; a stale reading does not reactive capacity. */
  readonly at: Date
  /**
   * Whether the reading proves remaining capacity. `null` balance is never
   * proof; a confirmed zero is proof of absence, not recovery.
   */
  readonly hasCapacity: boolean
}

/** Extracts recovery evidence from a successful reading, when it qualifies. */
export function recoveryEvidenceOf(reading: UsageReading, at: Date): UsageRecoveryEvidence {
  return {
    authoritative: reading.confidence === 'confirmed',
    scope: reading.scope,
    at,
    hasCapacity: hasRemainingCapacity(reading),
  }
}

/**
 * A reading proves remaining capacity when it has either an absolute
 * `balance` over zero (credit) or a non-null `remainingPercent` over zero
 * (subscription windows the upstream reports as a percentage). An unknown
 * `balance` and a null `remainingPercent` is the absence of proof, never a
 * silent zero.
 */
function hasRemainingCapacity(reading: UsageReading): boolean {
  if (reading.balance !== null) return reading.balance > 0
  if (reading.remainingPercent !== null) return reading.remainingPercent > 0
  return false
}
