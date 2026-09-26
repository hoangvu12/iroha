import { describe, expect, test } from 'bun:test'
import { createZaiUsageAdapter, zaiCapacityEvidenceOf, zaiUsageReadings } from '../../src/usage/zai-usage-adapter.ts'
import { reconcileCapacity } from '../../src/providers/capacity-reconciliation.ts'

const KEY = 'test-upstream-key'

/**
 * Real coding-plan quota bodies captured from the production Z.ai endpoint on
 * 2026-09-26, trimmed to the documented surface. Each `limits` array carries
 * more than one entry, and the entry that binds the key is not always the
 * first one — that is exactly what the adapter must survive.
 */
const ARREARS_BODY = {
  code: 200,
  msg: 'ok',
  success: true,
  data: {
    limits: [
      // An unconsumed monthly credit window …
      { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 12000, currentValue: 0, remaining: 12000, percentage: 0 },
      // … and the weekly credit window this key overspent (currentValue > usage
      // while remaining is 0). Inference answers this key with 1113
      // insufficient balance.
      { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 60000, currentValue: 60002, remaining: 0, percentage: 100, nextResetTime: 1790653118990 },
    ],
    level: 'pro',
  },
}

const WEEKLY_EXHAUSTED_BODY = {
  code: 200,
  msg: 'ok',
  success: true,
  data: {
    limits: [
      // The five-hour token window, untouched …
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 0 },
      // … the weekly token window, fully spent (inference answers 1310 weekly
      // limit with a reset matching this nextResetTime) …
      { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 100, nextResetTime: 1790478966999 },
      // … and the tool-call quota for search-prime / web-reader / zread, which
      // does not speak for chat completions at all.
      {
        type: 'TIME_LIMIT', unit: 5, number: 1, usage: 1000, currentValue: 0, remaining: 1000,
        percentage: 0, nextResetTime: 1791338485999,
        usageDetails: [
          { modelCode: 'search-prime', usage: 0 },
          { modelCode: 'web-reader', usage: 0 },
          { modelCode: 'zread', usage: 0 },
        ],
      },
    ],
    level: 'pro',
  },
}

const HEALTHY_BODY = {
  code: 200,
  msg: 'ok',
  success: true,
  data: {
    limits: [
      {
        type: 'TIME_LIMIT', unit: 5, number: 1, usage: 4000, currentValue: 2350, remaining: 1650,
        percentage: 58, nextResetTime: 1791786597997,
        usageDetails: [
          { modelCode: 'search-prime', usage: 2211 },
          { modelCode: 'web-reader', usage: 137 },
          { modelCode: 'zread', usage: 2 },
        ],
      },
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 95, nextResetTime: 1790469841394 },
    ],
    level: 'max',
  },
}

const respond = (body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch

describe('the Z.ai Usage Adapter', () => {
  test('reads the plan token window with Bearer auth', async () => {
    let url = ''
    let authorization = ''
    const adapter = createZaiUsageAdapter({ fetch: (async (input: Request | string | URL, init?: RequestInit) => {
      url = String(input)
      authorization = ((init?.headers ?? {}) as Record<string, string>).authorization ?? ''
      return new Response(JSON.stringify(HEALTHY_BODY), { status: 200 })
    }) as typeof fetch })
    const result = await adapter.read({ baseUrl: 'https://api.z.ai/api/coding/paas/v4', allowInsecureHttp: false, upstreamKey: KEY })
    expect(adapter.visibility).toBe('authoritative')
    expect(url).toBe('https://api.z.ai/api/monitor/usage/quota/limit')
    expect(authorization).toBe(`Bearer ${KEY}`)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The tool-call TIME_LIMIT quota is not a reading; the token window is.
    expect(result.readings).toHaveLength(1)
    expect(result.readings[0]).toMatchObject({
      plan: 'GLM Coding Plan', remainingPercent: 5, used: null, limit: null,
      resetAt: new Date(1790469841394), confidence: 'confirmed',
    })
  })

  test('selects the BigModel regional host from the Provider base URL', async () => {
    let url = ''
    const adapter = createZaiUsageAdapter({ fetch: (async (input: Request | string | URL) => {
      url = String(input)
      return new Response(JSON.stringify(HEALTHY_BODY), { status: 200 })
    }) as typeof fetch })
    await adapter.read({ baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', allowInsecureHttp: false, upstreamKey: KEY })
    expect(url).toBe('https://open.bigmodel.cn/api/monitor/usage/quota/limit')
  })

  test('reports no reading when a valid pay-as-you-go key has no coding plan', async () => {
    const adapter = createZaiUsageAdapter({ fetch: (async () => new Response(JSON.stringify({
      code: 500, msg: 'current user has no coding plan', success: false,
    }), { status: 200 })) as unknown as typeof fetch })
    const result = await adapter.read({ baseUrl: 'https://api.z.ai/api/paas/v4', allowInsecureHttp: false, upstreamKey: KEY })
    expect(result).toEqual({ ok: true, readings: [] })
  })

  test('reports no reading when a plan only carries the tool-call quota', async () => {
    // A successful envelope whose limits are all tool-call quotas has nothing
    // to say about chat capacity; an empty reading is the honest result, not a
    // parse failure.
    const adapter = createZaiUsageAdapter({ fetch: respond({
      code: 200, success: true, data: { limits: [HEALTHY_BODY.data.limits[0]] },
    }) })
    const result = await adapter.read({ baseUrl: 'https://api.z.ai/api/coding/paas/v4', allowInsecureHttp: false, upstreamKey: KEY })
    expect(result).toEqual({ ok: true, readings: [] })
  })

  test('reads one capacity-bearing entry per credit and token window', () => {
    expect(zaiUsageReadings(ARREARS_BODY)).toHaveLength(2)
    expect(zaiUsageReadings(WEEKLY_EXHAUSTED_BODY)).toHaveLength(2)
    expect(zaiUsageReadings(HEALTHY_BODY)).toHaveLength(1)
  })

  describe('a key whose weekly credit window is overspent', () => {
    // Production loop (2026-09-26): inference answered 1113 insufficient
    // balance, the registry parked the key exhausted, and the very next
    // entitlement poll resurrected it as "positive entitlement" because the
    // adapter read the *first* CREDIT_LIMIT entry — the unconsumed one — as
    // the whole story. Reconciliation must see the consumed entry and keep
    // the key parked.
    const at = new Date('2026-09-26T21:22:25.000Z')
    const evidence = zaiUsageReadings(ARREARS_BODY).map((reading) =>
      zaiCapacityEvidenceOf(reading, 'key-1', at))

    test('the consumed window is authoritative key-scoped exhaustion', () => {
      const exhausted = evidence.find((item) => item.availability === 'exhausted')
      expect(exhausted).toBeDefined()
      expect(exhausted).toMatchObject({
        authority: 'authoritative',
        scope: { kind: 'key', keyId: 'key-1' },
        reason: 'credit_exhausted',
        recheckAt: new Date(1790653118990),
      })
    })

    test('reconciliation keeps the parked key exhausted instead of resurrecting it', () => {
      const decision = reconcileCapacity({
        ownerEnabled: true,
        keyId: 'key-1',
        accountId: null,
        model: null,
        existing: {
          health: 'exhausted',
          reason: 'upstream HTTP 429',
          retryAfterAt: new Date('2026-09-26T21:37:25.000Z'),
          scope: 'key',
          scopeId: 'key-1',
          model: null,
        },
        credentialEvidence: null,
        capacityEvidence: evidence,
        now: at,
      })
      expect(decision.health).toBe('exhausted')
      expect(decision.routingEligible).toBe(false)
    })
  })

  describe('a key whose weekly token window is spent', () => {
    // The TIME_LIMIT entry is the tool-call quota and reads "100% remaining"
    // even while the weekly token window refuses inference with 1310. Reading
    // TIME_LIMIT as entitlement is what made this key look healthy.
    const at = new Date('2026-09-26T21:07:29.000Z')
    const evidence = zaiUsageReadings(WEEKLY_EXHAUSTED_BODY).map((reading) =>
      zaiCapacityEvidenceOf(reading, 'key-1', at))

    test('the tool-call quota produces no evidence', () => {
      expect(evidence.every((item) => item.diagnostics.limitingWindow !== 'time_limit')).toBe(true)
    })

    test('the spent token window is authoritative window exhaustion with its reset', () => {
      const exhausted = evidence.find((item) => item.availability === 'exhausted')
      expect(exhausted).toMatchObject({
        authority: 'authoritative',
        reason: 'window_exhausted',
        recheckAt: new Date(1790478966999),
      })
    })

    test('reconciliation parks the key instead of reading the tool quota as entitlement', () => {
      const decision = reconcileCapacity({
        ownerEnabled: true,
        keyId: 'key-1',
        accountId: null,
        model: null,
        existing: {
          health: 'cooling_down',
          reason: 'upstream HTTP 429',
          retryAfterAt: new Date('2026-09-26T21:07:34.000Z'),
          scope: 'key',
          scopeId: 'key-1',
          model: null,
        },
        credentialEvidence: null,
        capacityEvidence: evidence,
        now: at,
      })
      expect(decision.health).toBe('exhausted')
      expect(decision.routingEligible).toBe(false)
    })
  })

  describe('a healthy plan', () => {
    const at = new Date('2026-09-26T21:07:29.000Z')
    const evidence = zaiUsageReadings(HEALTHY_BODY).map((reading) =>
      zaiCapacityEvidenceOf(reading, 'key-1', at))

    test('remaining token capacity is positive entitlement', () => {
      expect(evidence).toHaveLength(1)
      expect(evidence[0]).toMatchObject({ availability: 'available', reason: 'positive_entitlement' })
    })

    test('reconciliation still reactivates a parked key on genuine capacity', () => {
      const decision = reconcileCapacity({
        ownerEnabled: true,
        keyId: 'key-1',
        accountId: null,
        model: null,
        existing: {
          health: 'exhausted',
          reason: 'window exhausted',
          retryAfterAt: new Date('2026-09-26T21:12:29.000Z'),
          scope: 'key',
          scopeId: 'key-1',
          model: null,
        },
        credentialEvidence: null,
        capacityEvidence: evidence,
        now: at,
      })
      expect(decision.health).toBe('active')
      expect(decision.routingEligible).toBe(true)
    })
  })

  test('maps an exhausted plan to authoritative key-scoped evidence', () => {
    const at = new Date('2026-08-17T00:00:00.000Z')
    const evidence = zaiCapacityEvidenceOf({
      unit: 'requests', balance: null, used: 100, limit: 100, remainingPercent: 0,
      plan: 'GLM Coding Plan', resetAt: new Date('2026-08-17T05:00:00.000Z'),
      scope: { kind: 'key', keyId: '' }, keyId: null, confidence: 'confirmed',
      diagnostics: { limitingWindow: 'time_limit' },
    }, 'key-1', at)
    expect(evidence.availability).toBe('exhausted')
    expect(evidence.authority).toBe('authoritative')
    expect(evidence.scope).toEqual({ kind: 'key', keyId: 'key-1' })
    expect(evidence.recheckAt).toEqual(new Date('2026-08-17T05:00:00.000Z'))
  })
})
