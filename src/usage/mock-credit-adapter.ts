import type {
  UsageAdapter,
  UsageAdapterRequest,
  UsagePollResult,
} from './adapter.ts'

/**
 * A deterministic mock credit-balance Usage Adapter for tests and
 * documentation: it reports an authoritative remaining-balance reading from a
 * value the test sets, supports per-key or per-account scope, and can simulate
 * upstream failures, rate limits, and unparseable responses.
 *
 * Tests assert scope, freshness, confidence, and capacity recovery; the
 * production generic adapter reports `unknown` so this mock only runs in
 * tests.
 */
export interface MockCreditUsageAdapterOptions {
  /** Per-key remaining balances; missing keys default to `null` (unknown). */
  readonly initialBalances?: Readonly<Record<string, number>>
  /** Whether the upstream reports the key or the account as the scope. */
  readonly scope?: 'key' | 'account'
  /** A fixed reset time the responses carry through. */
  readonly resetAt?: Date
  /**
   * The account ID the adapter's `account` scope names, so a test can match
   * the real Upstream Account without the mock knowing Iroha's internal IDs.
   * Required when `scope === 'account'` and the test expects account-scope
   * reactivation to work.
   */
  readonly accountId?: string
  /**
   * A mapping from the upstream key string the adapter sees to the
   * `upstream_keys.id` Iroha stores. Required when `scope === 'key'` and the
   * test expects key-scope reactivation to work.
   */
  readonly keyIdByUpstreamKey?: Readonly<Record<string, string>>
}

export interface MockCreditUsageAdapter extends UsageAdapter {
  /** Replaces the answer for every following call. */
  respondWith(
    answer:
      | UsagePollResult
      | ((request: UsageAdapterRequest, key: string) => UsagePollResult),
  ): void
  /** Sets the remaining balance for one upstream key. */
  setBalance(upstreamKey: string, balance: number): void
  /** Every recorded call, in order. */
  readonly calls: readonly UsageAdapterRequest[]
}

function defaultScopeOf(scope: 'key' | 'account' | undefined): 'key' | 'account' {
  return scope ?? 'account'
}

function asResult(
  value:
    | UsagePollResult
    | ((request: UsageAdapterRequest, key: string) => UsagePollResult),
  request: UsageAdapterRequest,
  key: string,
): UsagePollResult {
  return typeof value === 'function' ? value(request, key) : value
}

/**
 * Creates the mock credit Usage Adapter. The adapter is always authoritative
 * when its scripted answer is a success, never when it is a failure.
 */
export function createMockCreditUsageAdapter(
  options: MockCreditUsageAdapterOptions = {},
): MockCreditUsageAdapter {
  const balances = new Map<string, number>(
    Object.entries(options.initialBalances ?? {}),
  )
  const scopeKind = defaultScopeOf(options.scope)
  const resetAt = options.resetAt ?? null
  const accountId = options.accountId ?? 'mock-account-id'
  const keyIdByUpstreamKey = options.keyIdByUpstreamKey ?? {}
  const calls: UsageAdapterRequest[] = []
  let answer:
    | UsagePollResult
    | ((request: UsageAdapterRequest, key: string) => UsagePollResult) = (
    _request,
    key,
  ) => {
    const balance = balances.has(key) ? (balances.get(key) as number) : null
    return successReading({
      balance,
      scopeKind,
      resetAt,
      key,
      accountId,
      keyId: keyIdByUpstreamKey[key],
    })
  }

  const adapter: MockCreditUsageAdapter = {
    visibility: 'authoritative',
    calls,
    respondWith(next) {
      answer = next
    },
    setBalance(upstreamKey, balance) {
      balances.set(upstreamKey, balance)
    },
    async read(request) {
      calls.push(request)
      if (request.signal?.aborted === true) {
        return { ok: false, failure: { code: 'upstream_unreachable', message: 'cancelled' } }
      }
      return asResult(answer, request, request.upstreamKey)
    },
  }
  return adapter
}

function successReading(input: {
  balance: number | null
  scopeKind: 'key' | 'account'
  resetAt: Date | null
  key: string
  accountId: string
  keyId: string | undefined
}): UsagePollResult {
  const scope =
    input.scopeKind === 'account'
      ? ({ kind: 'account', accountId: input.accountId } as const)
      : input.keyId !== undefined
        ? ({ kind: 'key', keyId: input.keyId } as const)
        : ({ kind: 'key', keyId: input.key } as const)
  return {
    ok: true,
    reading: {
      unit: 'usd',
      balance: input.balance,
      used: input.balance === null ? null : Math.max(0, 100 - input.balance),
      limit: 100,
      resetAt: input.resetAt,
      scope,
      confidence: 'confirmed',
      diagnostics: { source: 'mock-credit-adapter' },
    },
  }
}
