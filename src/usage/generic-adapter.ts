import type {
  UsageAdapter,
  UsageAdapterRequest,
  UsagePollResult,
} from './adapter.ts'

/**
 * The generic OpenAI-compatible Usage Adapter. It is deliberately
 * `reactive_only`: the OpenAI `/usage` endpoint and similar generic surfaces
 * do not exist, and an inference-call status does not authorize the adapter
 * to claim an authoritative remaining balance.
 *
 * The adapter still exposes the same `read()` seam so the service can poll it
 * on the same schedule as typed adapters; every call returns the structured
 * unknown result the UI uses to render "no entitlement information" honestly.
 */
export function createGenericUsageAdapter(): UsageAdapter {
  return {
    visibility: 'reactive_only',
    async read(request: UsageAdapterRequest): Promise<UsagePollResult> {
      // A cancellation arrives here the same way it would for any adapter;
      // honour it before doing anything else.
      if (request.signal?.aborted === true) {
        return {
          ok: false,
          failure: { code: 'upstream_unreachable', message: 'the poll was cancelled' },
        }
      }
      return {
        ok: true,
        reading: {
          unit: 'unknown',
          balance: null,
          used: null,
          limit: null,
          resetAt: null,
          scope: { kind: 'unknown' },
          confidence: 'unknown',
          diagnostics: { reason: 'no entitlement API is exposed by the generic adapter' },
        },
      }
    },
  }
}
