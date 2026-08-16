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

/** DashScope stays OpenAI-compatible; only its failure semantics vary. */
export function createDashscopeInferenceAdapter(
  options: GenericInferenceAdapterOptions = {},
): InferenceAdapter {
  const generic = createGenericInferenceAdapter(options)
  return {
    capabilities: generic.capabilities,
    forward: generic.forward,
    classifyFailure(result: InferenceForwardResult): InferenceFailureClassification {
      if (result.status === 400 && dashscopeErrorCode(result) === DATA_INSPECTION_FAILED) {
        return {
          kind: 'content_inspection_failed',
          capacityScope: 'unknown',
          retryAction: 'try_alternate',
          retryAfterSeconds: null,
        }
      }
      return generic.classifyFailure(result)
    },
  }
}

function dashscopeErrorCode(result: InferenceForwardResult): string | null {
  if (result.kind !== 'buffered' || result.body === '') return null
  try {
    const root = JSON.parse(result.body) as Record<string, unknown>
    if (root === null || typeof root !== 'object') return null
    const error = root.error
    if (error === null || typeof error !== 'object' || Array.isArray(error)) return null
    const record = error as Record<string, unknown>
    const code = record.upstream_code ?? record.code ?? record.type
    return typeof code === 'string' ? code.toLowerCase() : null
  } catch {
    return null
  }
}
