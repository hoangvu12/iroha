import type {
  InferenceAdapter,
  InferenceFailureClassification,
  InferenceForwardResult,
} from './adapter.ts'
import {
  createGenericInferenceAdapter,
  type GenericInferenceAdapterOptions,
} from './generic-adapter.ts'

const DATA_INSPECTION_FAILED = 'data_inspection_failed'

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
    classifyFailure(result: InferenceForwardResult): InferenceFailureClassification {
      const error = dashscopeError(result)
      if (result.status === 400 && error.code === DATA_INSPECTION_FAILED) {
        return {
          kind: 'content_inspection_failed',
          capacityScope: 'unknown',
          retryAction: 'try_alternate',
          retryAfterSeconds: null,
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
        }
      }
      return generic.classifyFailure(result)
    },
  }
}

function modelUnavailable(status: number, error: DashscopeError): boolean {
  if (status === 404 && error.code !== null && MODEL_UNAVAILABLE_CODES.has(error.code)) return true
  return status === 400 && error.message !== null && MODEL_NOT_SUPPORTED_MESSAGE.test(error.message)
}

interface DashscopeError {
  readonly code: string | null
  readonly message: string | null
}

const NO_ERROR: DashscopeError = { code: null, message: null }

function dashscopeError(result: InferenceForwardResult): DashscopeError {
  if (result.kind !== 'buffered' || result.body === '') return NO_ERROR
  try {
    const root = JSON.parse(result.body) as Record<string, unknown>
    if (root === null || typeof root !== 'object') return NO_ERROR
    const error = root.error
    if (error === null || typeof error !== 'object' || Array.isArray(error)) return NO_ERROR
    const record = error as Record<string, unknown>
    const code = record.upstream_code ?? record.code ?? record.type
    const message = record.upstream_message ?? record.message
    return {
      code: typeof code === 'string' ? code.toLowerCase() : null,
      message: typeof message === 'string' ? message.trim() : null,
    }
  } catch {
    return NO_ERROR
  }
}
