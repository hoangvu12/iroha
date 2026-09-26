import type {
  InferenceAdapter,
  InferenceFailureClassification,
  InferenceForwardResult,
} from './adapter.ts'
import {
  createGenericInferenceAdapter,
  type GenericInferenceAdapterOptions,
} from './generic-adapter.ts'
import type { CapacityEvidence, ProviderDiagnostics } from '../providers/provider-evidence.ts'

/**
 * The Mistral Inference Adapter: typed failure classification for Mistral's
 * documented error envelope, OpenAI-shaped pass-through otherwise.
 *
 * Mistral speaks an OpenAI-compatible Chat Completions surface at
 * `https://api.mistral.ai/v1`. Its error body carries
 * `object: "error"` with a string `type`, a string `code`, and a
 * human-readable `message` (documented at
 * `https://docs.mistral.ai/api-reference/`), and the type is what
 * distinguishes failure shapes the HTTP status cannot:
 *
 *   - 402 billing_customer_monthly_spending_limit_reached (code 2300): the
 *     customer behind this key has reached its monthly spending limit. The
 *     refusal follows the credential — not the model, not the payload — and
 *     it clears only when the Owner raises the limit or the month rolls. That
 *     is a billing condition, so the adapter emits key-scoped
 *     `payment_required` with exhausted evidence and the shared
 *     reconciliation parks the key instead of letting it burn the first
 *     Attempt of every Request.
 *
 * Anything else keeps the generic classification. A bare 402 stays exactly
 * the generic reading the `failure-classification-retries` spec owns — status
 * alone does not name a billing condition, and the `billing_` type family is
 * the only spelling Mistral documents for one.
 */
interface MistralErrorEnvelope {
  readonly type: string | undefined
  readonly code: string | undefined
}

/** The documented prefix of every Mistral billing-condition error type. */
const BILLING_TYPE_PREFIX = 'billing_'

/** Mistral text inference stays OpenAI-compatible; only failure meaning varies. */
export function createMistralInferenceAdapter(
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
      const envelope = mistralErrorEnvelope(result)
      if (envelope === null) return genericClassification

      if (
        result.status === 402 &&
        envelope.type !== undefined &&
        envelope.type.startsWith(BILLING_TYPE_PREFIX) &&
        context !== undefined
      ) {
        return {
          ...genericClassification,
          kind: 'payment_required',
          // The spending limit belongs to the account behind this credential.
          // Iroha cannot tell which other keys share it, so the claim stays on
          // the key that proved it, exactly like DashScope's Arrearage.
          capacityScope: 'key',
          diagnostics: mistralDiagnostics({
            status: result.status,
            providerCode: envelope.code,
            providerType: envelope.type,
            classification: 'payment_required',
            capacityScope: 'key',
          }, context),
          capacityEvidence: billingExhaustionEvidence(result.status, envelope, context),
        }
      }

      // Nothing Mistral-specific to assert about the outcome, but the envelope
      // still names why the Attempt failed. Retaining the bounded identifiers
      // keeps the Owner's request history readable without asserting capacity.
      if (envelope.code === undefined && envelope.type === undefined) return genericClassification
      return {
        ...genericClassification,
        diagnostics: mistralDiagnostics({
          status: result.status,
          providerCode: envelope.code,
          providerType: envelope.type,
          classification: genericClassification.kind,
          capacityScope: genericClassification.capacityScope,
        }, context),
      }
    },
  }
}

/** Parses only the stable Mistral error envelope; messages stay behind. */
function mistralErrorEnvelope(result: InferenceForwardResult): MistralErrorEnvelope | null {
  if (result.kind !== 'buffered' || result.body === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(result.body)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  // Mistral's envelope is flat: `object: "error"` marks the body and the
  // identifiers sit at the root, unlike the nested `error` object OpenAI's
  // shape uses. Only the documented flat spelling is accepted.
  if (parsed.object !== 'error') return null
  const type = boundedIdentifier(parsed.type)
  const code = boundedIdentifier(parsed.code)
  if (type === undefined && code === undefined) return null
  return {
    ...(type === undefined ? {} : { type }),
    ...(code === undefined ? {} : { code }),
  }
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
function mistralDiagnostics(
  fields: Readonly<{
    status: number
    providerCode: string | undefined
    providerType: string | undefined
    classification: NonNullable<ProviderDiagnostics['classification']>
    capacityScope: NonNullable<ProviderDiagnostics['capacityScope']>
  }>,
  context: InferenceFailureContext | undefined,
): ProviderDiagnostics {
  const observedAt = context?.observedAt ?? new Date()
  return {
    status: fields.status,
    ...(fields.providerCode === undefined ? {} : { providerCode: fields.providerCode }),
    ...(fields.providerType === undefined ? {} : { providerType: fields.providerType }),
    classification: fields.classification,
    capacityScope: fields.capacityScope,
    evidenceAuthority: 'provisional',
    evidenceObservedAt: observedAt.toISOString(),
    // An inference observation is never entitlement, so it is stale the moment
    // it is taken and can never stand in for a Usage Adapter reading.
    evidenceFreshUntil: observedAt.toISOString(),
  }
}

/**
 * Key-scoped exhaustion for a spending-capped account. Mistral sends no
 * `Retry-After` with the refusal — the condition clears when the Owner raises
 * the limit, not on a timer — so `recheckAt` stays null and Key Health picks
 * the bounded recheck before it offers the key a controlled trial.
 */
function billingExhaustionEvidence(
  status: number,
  envelope: MistralErrorEnvelope,
  context: InferenceFailureContext,
): CapacityEvidence {
  return {
    availability: 'exhausted',
    authority: 'provisional',
    scope: { kind: 'key', keyId: context.keyId },
    reason: 'credit_exhausted',
    observedAt: context.observedAt,
    freshUntil: context.observedAt,
    recheckAt: null,
    facts: {},
    diagnostics: mistralDiagnostics(
      {
        status,
        providerCode: envelope.code,
        providerType: envelope.type,
        classification: 'payment_required',
        capacityScope: 'key',
      },
      context,
    ),
  }
}
