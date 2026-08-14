import type {
  UsageAdapter,
  UsageAdapterRequest,
  UsagePollResult,
} from './adapter.ts'

/**
 * A deterministic mock subscription / coding-plan Usage Adapter for tests:
 * reports authoritative `used` and `limit` against a known window, with a
 * reset time the test controls. Like the credit adapter, it can simulate
 * upstream failures and rate limits, and the connection-wide or per-model
 * scope is chosen by the test.
 */
export interface MockPlanUsageAdapterOptions {
  /** Used amount in the current window. */
  readonly used?: number
  /** Total allowance in the current window. */
  readonly limit?: number
  /** When the window resets. */
  readonly resetAt?: Date
  /** Where the entitlement applies. */
  readonly scope?: 'connection_model' | 'provider'
  /** The model the reading speaks to when `scope` is `connection_model`. */
  readonly model?: string
}

export interface MockPlanUsageAdapter extends UsageAdapter {
  respondWith(
    answer:
      | UsagePollResult
      | ((request: UsageAdapterRequest) => UsagePollResult),
  ): void
  /** Sets the window usage for the following calls. */
  setWindow(used: number, limit: number): void
  readonly calls: readonly UsageAdapterRequest[]
}

export function createMockPlanUsageAdapter(
  options: MockPlanUsageAdapterOptions = {},
): MockPlanUsageAdapter {
  const resetAt = options.resetAt ?? null
  const scopeKind = options.scope ?? 'provider'
  const model = options.model ?? null
  let used = options.used ?? 0
  let limit = options.limit ?? 100
  const calls: UsageAdapterRequest[] = []
  let answer:
    | UsagePollResult
    | ((request: UsageAdapterRequest) => UsagePollResult) = () => {
    return planReading({ used, limit, resetAt, scopeKind, model })
  }

  return {
    visibility: 'authoritative',
    calls,
    respondWith(next) {
      answer = next
    },
    setWindow(nextUsed, nextLimit) {
      used = nextUsed
      limit = nextLimit
    },
    async read(request) {
      calls.push(request)
      if (request.signal?.aborted === true) {
        return { ok: false, failure: { code: 'upstream_unreachable', message: 'cancelled' } }
      }
      return typeof answer === 'function' ? answer(request) : answer
    },
  }
}

function planReading(input: {
  used: number
  limit: number
  resetAt: Date | null
  scopeKind: 'connection_model' | 'provider'
  model: string | null
}): UsagePollResult {
  const remaining = Math.max(0, input.limit - input.used)
  const remainingPercent = input.limit === 0 ? 0 : Math.round((remaining * 100) / input.limit)
  const scope =
    input.scopeKind === 'connection_model'
      ? ({ kind: 'connection_model', model: input.model ?? 'unknown-model' } as const)
      : ({ kind: 'provider' } as const)
  return {
    ok: true,
    readings: [
      {
        unit: 'requests',
        balance: null,
        used: null,
        limit: null,
        remainingPercent,
        plan: input.scopeKind === 'connection_model' ? input.model ?? null : null,
        resetAt: input.resetAt,
        scope,
        confidence: 'confirmed',
        diagnostics: { source: 'mock-plan-adapter' },
      },
    ],
  }
}
