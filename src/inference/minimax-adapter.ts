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
import type { ProviderDiagnostics } from '../providers/provider-evidence.ts'

interface MinimaxErrorEnvelope {
  readonly code?: string
  readonly type?: string
}

/** MiniMax text remains OpenAI-compatible; this adapter owns only failure meaning. */
export function createMinimaxInferenceAdapter(
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
      if ((result.status !== 402 && result.status !== 429) || context === undefined) {
        return genericClassification
      }

      const envelope = minimaxErrorEnvelope(result)
      if (envelope === null) return genericClassification

      const retryAfterSeconds = genericClassification.retryAfterSeconds
      const classification = result.status === 402 ? 'payment_required' : 'capacity_limited'
      const retryAt = retryAfterSeconds === null
        ? undefined
        : new Date(context.observedAt.getTime() + retryAfterSeconds * 1_000).toISOString()
      const diagnostics: ProviderDiagnostics = {
        status: result.status,
        ...(envelope.code === undefined ? {} : { providerCode: envelope.code }),
        ...(envelope.type === undefined ? {} : { providerType: envelope.type }),
        classification,
        capacityScope: 'key',
        evidenceAuthority: 'provisional',
        evidenceObservedAt: context.observedAt.toISOString(),
        evidenceFreshUntil: context.observedAt.toISOString(),
        ...(retryAfterSeconds === null ? {} : { retryAfterSeconds }),
        ...(retryAt === undefined ? {} : { retryAt }),
      }

      return {
        ...genericClassification,
        capacityScope: 'key',
        diagnostics,
        capacityEvidence: {
          availability: result.status === 402 ? 'exhausted' : 'temporarily_limited',
          authority: 'provisional',
          scope: { kind: 'key', keyId: context.keyId },
          reason: result.status === 402 ? 'unknown' : 'temporarily_limited',
          observedAt: context.observedAt,
          // Inference observations are not entitlement and never become fresh authority.
          freshUntil: context.observedAt,
          recheckAt: retryAfterSeconds === null
            ? null
            : new Date(context.observedAt.getTime() + retryAfterSeconds * 1_000),
          facts: {},
          diagnostics,
        },
      }
    },
  }
}

/** Parses only the stable OpenAI-shaped fields; messages and unknown fields stay behind. */
function minimaxErrorEnvelope(result: InferenceForwardResult): MinimaxErrorEnvelope | null {
  if (result.kind !== 'buffered' || result.body === '') return null
  try {
    const root: unknown = JSON.parse(result.body)
    if (!isRecord(root) || !isRecord(root.error)) return null
    const code = boundedIdentifier(root.error.upstream_code ?? root.error.code)
    const type = boundedIdentifier(root.error.upstream_type ?? root.error.type)
    // A structurally empty `{ error: {} }` is not recognizable evidence.
    return code === undefined && type === undefined
      ? null
      : {
          ...(code === undefined ? {} : { code }),
          ...(type === undefined ? {} : { type }),
        }
  } catch {
    return null
  }
}

function boundedIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 64
    ? value
    : undefined
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
