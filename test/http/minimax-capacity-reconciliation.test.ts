import { afterEach, describe, expect, test } from 'bun:test'
import type { UsageAdapter, UsagePollResult } from '../../src/usage/index.ts'
import { completeSetup, createTestApp, type TestApp } from '../support/app.ts'
import { mockUpstreamTransport } from '../support/inference.ts'

const KEY_ZERO = 'sk-minimax-zero-capacity'
const KEY_NEGATIVE = 'sk-minimax-negative-capacity'
const MODEL = 'MiniMax-M3'

interface ProviderBody {
  id: string
  keys: Array<{ id: string; health: string; healthReason: string | null }>
}

function authoritativeKeyCredit(): UsageAdapter & {
  balances: Map<string, number>
  fail: boolean
  calls: string[]
} {
  const adapter = {
    visibility: 'authoritative' as const,
    balances: new Map([[KEY_ZERO, 0], [KEY_NEGATIVE, -2.5]]),
    fail: false,
    calls: [] as string[],
    async read(request: { upstreamKey: string }): Promise<UsagePollResult> {
      adapter.calls.push(request.upstreamKey)
      if (adapter.fail) {
        return { ok: false, failure: { code: 'upstream_unreachable', message: 'entitlement unavailable' } }
      }
      const balance = adapter.balances.get(request.upstreamKey) ?? 0
      return {
        ok: true,
        readings: [{
          unit: 'cny', balance, used: null, limit: null, remainingPercent: null,
          plan: null, resetAt: null, scope: { kind: 'provider' }, keyId: null,
          confidence: 'confirmed', diagnostics: { kind: 'credit' },
        }],
      }
    },
  }
  return adapter
}

describe('MiniMax capacity reconciliation through the assembled HTTP application', () => {
  let apps: TestApp[] = []

  afterEach(async () => {
    await Promise.all(apps.map((app) => app.dispose()))
    apps = []
  })

  test('one refresh excludes zero and negative authoritative capacity, preserves stale exhaustion, and recovers on fresh positive evidence', async () => {
    const usage = authoritativeKeyCredit()
    const iroha = await createTestApp({ usageAdapter: usage })
    apps.push(iroha)
    const csrf = (await completeSetup(iroha)).csrf
    const created = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST', headers: { 'content-type': 'application/json' }, csrf,
      body: JSON.stringify({
        displayName: 'MiniMax capacity fixture',
        baseUrl: 'https://api.minimax.io/v1',
        keys: [{ upstreamKey: KEY_ZERO }, { upstreamKey: KEY_NEGATIVE }],
      }),
    })
    expect(created.status).toBe(201)
    const provider = (await created.json()) as ProviderBody

    const exhausted = await iroha.fetch(`/api/v1/admin/providers/${provider.id}/usage/refresh`, {
      method: 'POST', csrf,
    })
    expect(exhausted.status).toBe(200)
    expect(usage.calls).toHaveLength(2)
    const afterExhaustion = (await (await iroha.fetch(`/api/v1/admin/providers/${provider.id}`)).json()) as ProviderBody
    expect(afterExhaustion.keys.map((key) => key.health)).toEqual(['exhausted', 'exhausted'])

    usage.fail = true
    iroha.clock.advance(2)
    const stale = await iroha.fetch(`/api/v1/admin/providers/${provider.id}/usage/refresh`, {
      method: 'POST', csrf,
    })
    expect(stale.status).toBe(200)
    const staleBody = await stale.json() as { stale: boolean; readings: Array<{ balance: number | null }> }
    expect(staleBody.stale).toBe(true)
    expect(staleBody.readings.map((reading) => reading.balance).sort()).toEqual([-2.5, 0])
    const afterFailure = (await (await iroha.fetch(`/api/v1/admin/providers/${provider.id}`)).json()) as ProviderBody
    expect(afterFailure.keys.map((key) => key.health)).toEqual(['exhausted', 'exhausted'])

    usage.fail = false
    usage.balances.set(KEY_ZERO, 1)
    usage.balances.set(KEY_NEGATIVE, 3)
    iroha.clock.advance(2)
    const recovered = await iroha.fetch(`/api/v1/admin/providers/${provider.id}/usage/refresh`, {
      method: 'POST', csrf,
    })
    expect(recovered.status).toBe(200)
    const afterRecovery = (await (await iroha.fetch(`/api/v1/admin/providers/${provider.id}`)).json()) as ProviderBody
    expect(afterRecovery.keys.map((key) => key.health)).toEqual(['active', 'active'])
  })

  for (const status of [402, 429] as const) {
    test(`structured MiniMax ${status} uses one alternate and retains sanitized diagnostics while finalizing success`, async () => {
      const secret = `sk-secret-in-${status}-message`
      const upstream = mockUpstreamTransport()
      let calls = 0
      upstream.respondWith(() => {
        calls++
        if (calls === 1) {
          return Response.json({
            error: {
              code: status === 402 ? 'insufficient_credit' : 'rate_limit_exceeded',
              type: status === 402 ? 'billing_error' : 'rate_limit_error',
              message: `arbitrary ${secret}`,
              headers: { authorization: `Bearer ${secret}` },
            },
          }, { status, headers: status === 429 ? { 'retry-after': '11' } : {} })
        }
        return Response.json({
          id: `chatcmpl-recovered-${status}`, object: 'chat.completion', created: 1,
          model: MODEL,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      })

      const iroha = await createTestApp({ upstreamTransport: upstream.fetch })
      apps.push(iroha)
      const csrf = (await completeSetup(iroha)).csrf
      const created = await iroha.fetch('/api/v1/admin/providers', {
        method: 'POST', headers: { 'content-type': 'application/json' }, csrf,
        body: JSON.stringify({
          templateId: 'MiniMax', displayName: `MiniMax ${status}`,
          baseUrl: 'https://api.minimax.io/v1',
          keys: [{ upstreamKey: 'sk-minimax-first' }, { upstreamKey: 'sk-minimax-alternate' }],
        }),
      })
      expect(created.status).toBe(201)
      const provider = (await created.json()) as ProviderBody
      const gatewayKey = await iroha.fetch('/api/v1/admin/gateway-keys', {
        method: 'POST', headers: { 'content-type': 'application/json' }, csrf,
        body: JSON.stringify({ name: `MiniMax ${status} caller`, scope: [{ providerId: provider.id }] }),
      })
      const { secret: gatewaySecret } = await gatewayKey.json() as { secret: string }

      const inference = await iroha.fetch(`/providers/${provider.id}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${gatewaySecret}` },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'user', content: 'recover' }],
          stream: status === 429,
        }),
      })
      expect(inference.status).toBe(200)
      expect(calls).toBe(2)
      const requestId = inference.headers.get('x-request-id')
      expect(requestId).not.toBeNull()

      const detail = await iroha.fetch(`/api/v1/admin/requests/${requestId}`)
      expect(detail.status).toBe(200)
      const body = await detail.json() as {
        event: { status: number; outcome: string; errorCode: string | null }
        attempts: Array<{ status: number; outcome: string; diagnostics: Record<string, unknown> }>
      }
      expect(body.event).toMatchObject({ status: 200, outcome: 'success', errorCode: null })
      expect(body.attempts.map((attempt) => ({ status: attempt.status, outcome: attempt.outcome }))).toEqual([
        { status, outcome: 'failure' }, { status: 200, outcome: 'success' },
      ])
      expect(body.attempts[0]?.diagnostics).toMatchObject({
        status,
        providerCode: status === 402 ? 'insufficient_credit' : 'rate_limit_exceeded',
        providerType: status === 402 ? 'billing_error' : 'rate_limit_error',
        classification: status === 402 ? 'payment_required' : 'capacity_limited',
        capacityScope: 'key',
      })
      expect(JSON.stringify(body)).not.toContain(secret)
    })
  }
})
