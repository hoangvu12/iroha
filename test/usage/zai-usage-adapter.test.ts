import { describe, expect, test } from 'bun:test'
import { createZaiUsageAdapter, zaiCapacityEvidenceOf } from '../../src/usage/zai-usage-adapter.ts'

const KEY = 'test-upstream-key'
const PLAN = {
  code: 200,
  data: { limits: [
    { type: 'TIME_LIMIT', unit: 'requests', usage: 100, currentValue: 75, remaining: 25, percentage: 75, nextResetTime: 1_900_000_000_000 },
    { type: 'TOKENS_LIMIT', percentage: 10 },
  ] },
  success: true,
}

describe('the Z.ai Usage Adapter', () => {
  test('reads a coding-plan window with Bearer auth', async () => {
    let url = ''
    let authorization = ''
    const adapter = createZaiUsageAdapter({ fetch: (async (input: Request | string | URL, init?: RequestInit) => {
      url = String(input)
      authorization = ((init?.headers ?? {}) as Record<string, string>).authorization ?? ''
      return new Response(JSON.stringify(PLAN), { status: 200 })
    }) as typeof fetch })
    const result = await adapter.read({ baseUrl: 'https://api.z.ai/api/coding/paas/v4', allowInsecureHttp: false, upstreamKey: KEY })
    expect(adapter.visibility).toBe('authoritative')
    expect(url).toBe('https://api.z.ai/api/monitor/usage/quota/limit')
    expect(authorization).toBe(`Bearer ${KEY}`)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.readings[0]).toMatchObject({
      plan: 'GLM Coding Plan', used: 75, limit: 100, remainingPercent: 25,
      resetAt: new Date(1_900_000_000_000), confidence: 'confirmed',
    })
  })

  test('selects the BigModel regional host from the Provider base URL', async () => {
    let url = ''
    const adapter = createZaiUsageAdapter({ fetch: (async (input: Request | string | URL) => {
      url = String(input)
      return new Response(JSON.stringify(PLAN), { status: 200 })
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
