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

const DATA_INSPECTION_FAILED = 'data_inspection_failed'

/**
 * DashScope answers a key whose Alibaba Cloud account is overdue with an
 * HTTP 400 rather than the 402 the generic adapter reads as a billing
 * condition:
 *
 *   400 Arrearage  Access denied, please make sure your account is in good standing.
 *
 * Generic 400 semantics stop the Request, which is exactly wrong here: the
 * request is fine, the credential's account is not, and every other Upstream
 * Key of the Provider can still serve it. Naming the condition turns a hard
 * caller-visible failure into a retry on an alternate key, and the key-scoped
 * Capacity Evidence lets Key Health park the credential until the Owner
 * settles the account instead of feeding it a share of traffic forever.
 */
const ARREARAGE = 'arrearage'

/**
 * DashScope reports "this key cannot call this model" three different ways,
 * and which one you get depends on the entitlement tier of the key that asked:
 *
 *   400 invalid_parameter_error  model `X` is not supported.
 *   404 model_not_found          The model `X` does not exist or you do not have access to it.
 *   404 model_not_supported      Unsupported model `X` for OpenAI compatibility mode.
 *
 * All three mean the same thing to us. `invalid_parameter_error` is the catch-all
 * DashScope also uses for ordinary bad parameters, so that one is recognised by
 * its message rather than its code alone — a malformed temperature must still
 * stop the Request rather than walk every Upstream Key.
 *
 * None of the three distinguishes a model the key lacks from a model that does
 * not exist at all; a mistyped model produces byte-identical errors. That
 * distinction is not the adapter's to make. The routing layer draws it from Key
 * Model Availability before it ever sends an Attempt.
 */
const MODEL_NOT_SUPPORTED_MESSAGE = /^model\s+`[^`]+`\s+is not supported\.?$/i
const MODEL_UNAVAILABLE_CODES = new Set(['model_not_found', 'model_not_supported'])

/** DashScope stays OpenAI-compatible; only its failure semantics vary. */
export function createDashscopeInferenceAdapter(
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
      const error = dashscopeError(result)

      if (result.status === 400 && error.code === ARREARAGE && context !== undefined) {
        return {
          ...genericClassification,
          kind: 'payment_required',
          // The overdue balance belongs to the account behind this credential.
          // Iroha cannot tell which other keys share it — Upstream Account is
          // on its way out — so the claim stays on the key that proved it.
          capacityScope: 'key',
          retryAction: 'try_alternate',
          diagnostics: dashscopeDiagnostics(
            { status: result.status, error, classification: 'payment_required', capacityScope: 'key' },
            context,
          ),
          capacityEvidence: arrearageEvidence(result.status, error, context),
        }
      }

      if (result.status === 400 && error.code === DATA_INSPECTION_FAILED) {
        return {
          kind: 'content_inspection_failed',
          capacityScope: 'unknown',
          retryAction: 'try_alternate',
          retryAfterSeconds: null,
          diagnostics: dashscopeDiagnostics(
            {
              status: result.status,
              error,
              classification: 'content_inspection_failed',
              capacityScope: 'unknown',
            },
            context,
          ),
        }
      }

      if (modelUnavailable(result.status, error)) {
        return {
          kind: 'model_unavailable',
          // Entitlement, not capacity: this key is healthy, it simply does not
          // carry this model. Naming a scope here would cool down a good key.
          capacityScope: 'unknown',
          retryAction: 'try_alternate',
          retryAfterSeconds: null,
          diagnostics: dashscopeDiagnostics(
            {
              status: result.status,
              error,
              classification: 'model_unavailable',
              capacityScope: 'unknown',
            },
            context,
          ),
        }
      }

      // Nothing DashScope-specific to say about the outcome, but the envelope
      // still names why the Attempt failed. Retaining the bounded code keeps
      // the Owner's request history readable without asserting capacity.
      if (error.rawCode === null) return genericClassification
      return {
        ...genericClassification,
        diagnostics: dashscopeDiagnostics(
          {
            status: result.status,
            error,
            classification: genericClassification.kind,
            capacityScope: genericClassification.capacityScope,
          },
          context,
        ),
      }
    },
  }
}

function modelUnavailable(status: number, error: DashscopeError): boolean {
  if (status === 404 && error.code !== null && MODEL_UNAVAILABLE_CODES.has(error.code)) return true
  return status === 400 && error.message !== null && MODEL_NOT_SUPPORTED_MESSAGE.test(error.message)
}

interface DashscopeError {
  /** Lowercased for matching. */
  readonly code: string | null
  readonly message: string | null
  /** The code as DashScope spelled it, for diagnostics. */
  readonly rawCode: string | null
  readonly type: string | null
}

const NO_ERROR: DashscopeError = { code: null, message: null, rawCode: null, type: null }

function dashscopeError(result: InferenceForwardResult): DashscopeError {
  if (result.kind !== 'buffered' || result.body === '') return NO_ERROR
  try {
    const root = JSON.parse(result.body) as Record<string, unknown>
    if (root === null || typeof root !== 'object') return NO_ERROR
    const error = root.error
    if (error === null || typeof error !== 'object' || Array.isArray(error)) return NO_ERROR
    const record = error as Record<string, unknown>
    const code = record.upstream_code ?? record.code ?? record.type
    const type = record.upstream_type ?? record.type
    const message = record.upstream_message ?? record.message
    return {
      code: typeof code === 'string' ? code.toLowerCase() : null,
      message: typeof message === 'string' ? message.trim() : null,
      rawCode: typeof code === 'string' ? code : null,
      type: typeof type === 'string' ? type : null,
    }
  } catch {
    return NO_ERROR
  }
}

/**
 * The bounded Provider Diagnostics DashScope failures carry into the Owner's
 * request history. Only allow-listed envelope identifiers travel; the message
 * DashScope wrote is deliberately left behind.
 */
function dashscopeDiagnostics(
  fields: Readonly<{
    status: number
    error: DashscopeError
    classification: NonNullable<ProviderDiagnostics['classification']>
    capacityScope: NonNullable<ProviderDiagnostics['capacityScope']>
  }>,
  context: InferenceFailureContext | undefined,
): ProviderDiagnostics {
  const observedAt = context?.observedAt ?? new Date()
  return {
    status: fields.status,
    ...(fields.error.rawCode === null ? {} : { providerCode: fields.error.rawCode }),
    ...(fields.error.type === null ? {} : { providerType: fields.error.type }),
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
 * Key-scoped exhaustion for an overdue account. DashScope sends no
 * `Retry-After` with `Arrearage` — the condition clears when the Owner pays,
 * not on a timer — so `recheckAt` stays null and Key Health picks the cooldown
 * before it offers the key a controlled trial.
 */
function arrearageEvidence(
  status: number,
  error: DashscopeError,
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
    diagnostics: dashscopeDiagnostics(
      { status, error, classification: 'payment_required', capacityScope: 'key' },
      context,
    ),
  }
}
