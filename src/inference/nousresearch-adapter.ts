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
 * The Nous Research Inference Adapter: typed failure classification for the
 * Nous Research inference API's documented error envelope, OpenAI-shaped
 * pass-through otherwise.
 *
 * Nous Research speaks an OpenAI-compatible Chat Completions surface at
 * `https://inference-api.nousresearch.com/v1`. Its refusal bodies are a flat
 * envelope — `{ status, message, code }` with no `error` object — and one
 * code is a billing condition the HTTP status misrepresents:
 *
 *   - 404 insufficient_credits_for_paid_model: the model exists and the key
 *     is accepted, but the account behind it has no credits, so every paid
 *     model answers 404. A bare 404 reads as "this key does not carry the
 *     model" (`request_rejected`, `connection_model` scope), which misleads
 *     the routing layer and the Owner: the credential is fine, the account
 *     is empty.
 *
 *     This is the same shape as DashScope's `AllocationQuota.FreeTierOnly`
 *     and Mistral's `billing_customer_monthly_spending_limit_reached`:
 *     a billing condition attached to the account behind the credential, so
 *     the adapter emits key-scoped `payment_required` with exhausted
 *     evidence and the shared reconciliation parks the key durably. Free
 *     models keep answering for such an account, but Iroha parks the key on
 *     the billing reading the Provider itself sent — exactly as the Owner
 *     chose for the FreeTierOnly signature — and a recheck or a manual test
 *     that proves real capacity revives it.
 *
 * Anything else keeps the generic classification. A bare 404 without this
 * code stays the generic `request_rejected` reading the
 * failure-classification-retries spec owns.
 */
interface NousResearchErrorEnvelope {
  readonly code: string | undefined
}

/** The documented code Nous Research answers an out-of-credit account with. */
const INSUFFICIENT_CREDITS_FOR_PAID_MODEL = 'insufficient_credits_for_paid_model'

/** Nous Research text inference stays OpenAI-compatible; only failure meaning varies. */
export function createNousResearchInferenceAdapter(
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
      const envelope = nousResearchErrorEnvelope(result)
      if (envelope === null) return genericClassification

      if (
        result.status === 404 &&
        envelope.code === INSUFFICIENT_CREDITS_FOR_PAID_MODEL &&
        context !== undefined
      ) {
        return {
          ...genericClassification,
          kind: 'payment_required',
          // The empty account belongs to the account behind this credential.
          // Iroha cannot tell which other keys share it, so the claim stays on
          // the key that proved it, exactly like DashScope's Arrearage.
          capacityScope: 'key',
          diagnostics: nousResearchDiagnostics({
            status: result.status,
            providerCode: envelope.code,
            classification: 'payment_required',
            capacityScope: 'key',
          }, context),
          capacityEvidence: billingExhaustionEvidence(result.status, envelope, context),
        }
      }

      // Nothing Nous Research-specific to assert about the outcome, but the
      // envelope still names why the Attempt failed. Retaining the bounded
      // code keeps the Owner's request history readable without asserting
      // capacity.
      if (envelope.code === undefined) return genericClassification
      return {
        ...genericClassification,
        diagnostics: nousResearchDiagnostics({
          status: result.status,
          providerCode: envelope.code,
          classification: genericClassification.kind,
          capacityScope: genericClassification.capacityScope,
        }, context),
      }
    },
  }
}

/**
 * Parses only the stable flat Nous Research envelope; messages stay behind.
 * The envelope has no `error` object and no `type` — a bounded `code` at the
 * root is the whole documented surface.
 */
function nousResearchErrorEnvelope(result: InferenceForwardResult): NousResearchErrorEnvelope | null {
  if (result.kind !== 'buffered' || result.body === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(result.body)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const code = boundedIdentifier(parsed.code)
  if (code === undefined) return null
  return { code }
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
function nousResearchDiagnostics(
  fields: Readonly<{
    status: number
    providerCode: string | undefined
    classification: NonNullable<ProviderDiagnostics['classification']>
    capacityScope: NonNullable<ProviderDiagnostics['capacityScope']>
  }>,
  context: InferenceFailureContext | undefined,
): ProviderDiagnostics {
  const observedAt = context?.observedAt ?? new Date()
  return {
    status: fields.status,
    ...(fields.providerCode === undefined ? {} : { providerCode: fields.providerCode }),
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
 * Key-scoped exhaustion for an account without credits. Nous Research sends
 * no `Retry-After` with the refusal — the condition clears when the Owner
 * adds credits, not on a timer — so `recheckAt` stays null and Key Health
 * picks the bounded recheck before it offers the key a controlled trial.
 */
function billingExhaustionEvidence(
  status: number,
  envelope: NousResearchErrorEnvelope,
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
    diagnostics: nousResearchDiagnostics(
      {
        status,
        providerCode: envelope.code,
        classification: 'payment_required',
        capacityScope: 'key',
      },
      context,
    ),
  }
}
