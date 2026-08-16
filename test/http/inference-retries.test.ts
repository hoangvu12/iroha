import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { completeSetup, createTestApp, type TestApp } from '../support/app.ts'
import { mockUpstreamTransport } from '../support/inference.ts'

const BASE_URL = 'https://api.example.com/v1'
const MODEL = 'gpt-4o-mini'
const FIRST_KEY = 'sk-first-retry-key'
const SECOND_KEY = 'sk-second-retry-key'

describe('scoped inference retries', () => {
  let iroha: TestApp
  let upstream: ReturnType<typeof mockUpstreamTransport>
  let csrf: string
  let providerId: string
  let secret: string

  beforeEach(async () => {
    upstream = mockUpstreamTransport()
    iroha = await createTestApp({ upstreamTransport: upstream.fetch })
    csrf = (await completeSetup(iroha)).csrf
    const created = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        templateId: 'dashscope',
        displayName: 'Retry',
        baseUrl: BASE_URL,
        keys: [{ upstreamKey: FIRST_KEY }],
      }),
      csrf,
    })
    providerId = ((await created.json()) as { id: string }).id
    await iroha.fetch(`/api/v1/admin/providers/${providerId}/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upstreamKey: SECOND_KEY }),
      csrf,
    })
    const key = await iroha.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Retry app', scope: [{ providerId }] }),
      csrf,
    })
    secret = ((await key.json()) as { secret: string }).secret
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  const chat = () =>
    iroha.fetch(`/providers/${providerId}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Hello' }] }),
    })

  test('rotates immediately after confirmed invalid authentication', async () => {
    upstream.respondWith(() =>
      upstream.calls.length === 1 ? new Response('invalid', { status: 401 }) : Response.json(completion()),
    )

    const response = await chat()

    expect(response.status).toBe(200)
    expect(upstream.calls).toHaveLength(2)
    expect(upstream.calls[0]?.headers.authorization).not.toBe(upstream.calls[1]?.headers.authorization)
    const keys = await iroha.database.providers.listKeys(providerId)
    expect(keys.find((key) => key.encryptedKey !== '')?.health).toBeDefined()
    expect(keys.map((key) => key.health).sort()).toEqual(['active', 'invalid_authentication'])
  })

  test('generic unknown-scope 429 tries at most one alternate without durable exhaustion', async () => {
    upstream.respondWith(() => new Response('slow', { status: 429, headers: { 'retry-after': '17' } }))

    const response = await chat()

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('17')
    expect(upstream.calls).toHaveLength(2)
    const keys = await iroha.database.providers.listKeys(providerId)
    expect(keys.map((key) => key.health).sort()).toEqual(['active', 'active'])
  })

  test('unrecognized 402 tries one alternate without durably exhausting either key', async () => {
    upstream.respondWith(() =>
      upstream.calls.length === 1
        ? new Response('payment required', { status: 402 })
        : Response.json(completion()),
    )

    const response = await chat()

    expect(response.status).toBe(200)
    expect(upstream.calls).toHaveLength(2)
    expect(upstream.calls[0]?.headers.authorization).not.toBe(upstream.calls[1]?.headers.authorization)
    const keys = await iroha.database.providers.listKeys(providerId)
    expect(keys.map((key) => key.health).sort()).toEqual(['active', 'active'])
  })

  test('unrecognized 402 stops after one alternate even when another key is eligible', async () => {
    await iroha.fetch(`/api/v1/admin/providers/${providerId}/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upstreamKey: 'sk-third-retry-key' }),
      csrf,
    })
    upstream.respondWith(() => new Response('payment required', { status: 402 }))

    const response = await chat()

    expect(response.status).toBe(402)
    expect(upstream.calls).toHaveLength(2)
    const keys = await iroha.database.providers.listKeys(providerId)
    expect(keys.map((key) => key.health).sort()).toEqual(['active', 'active', 'active'])
  })

  test('explicit server failure retries the same key once with a bounded attempt count', async () => {
    upstream.respondWith((call) =>
      upstream.calls.length === 1 ? new Response('down', { status: 503 }) : Response.json(completion()),
    )

    const response = await chat()

    expect(response.status).toBe(200)
    expect(upstream.calls).toHaveLength(2)
    expect(upstream.calls[0]?.headers.authorization).toBe(upstream.calls[1]?.headers.authorization)
  })

  test('explicit server retry uses the bounded backoff seam', async () => {
    await iroha.dispose()
    const delays: number[] = []
    upstream = mockUpstreamTransport((call) =>
      upstream.calls.length === 1 ? new Response('down', { status: 503 }) : Response.json(completion()),
    )
    iroha = await createTestApp({
      upstreamTransport: upstream.fetch,
      retrySleep: async (ms) => {
        delays.push(ms)
      },
    })
    csrf = (await completeSetup(iroha)).csrf
    const created = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Retry delay', baseUrl: BASE_URL, keys: [{ upstreamKey: FIRST_KEY }] }),
      csrf,
    })
    providerId = ((await created.json()) as { id: string }).id
    const key = await iroha.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Retry app', scope: [{ providerId }] }),
      csrf,
    })
    secret = ((await key.json()) as { secret: string }).secret

    const response = await chat()

    expect(response.status).toBe(200)
    expect(delays).toEqual([100])
  })

  test('validation errors never retry', async () => {
    upstream.respondWith(() => new Response('invalid request', { status: 400 }))

    const response = await chat()

    expect(response.status).toBe(400)
    expect(upstream.calls).toHaveLength(1)
  })

  test('MiniMax structured 402 reconciles fresh zero entitlement and reports known exhaustion', async () => {
    const created = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST', headers: { 'content-type': 'application/json' }, csrf,
      body: JSON.stringify({
        templateId: 'MiniMax', displayName: 'MiniMax capacity', baseUrl: BASE_URL,
        keys: [{ upstreamKey: 'sk-minimax-first' }],
      }),
    })
    const minimaxId = ((await created.json()) as { id: string }).id
    await iroha.fetch(`/api/v1/admin/providers/${minimaxId}/keys`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, csrf,
      body: JSON.stringify({ upstreamKey: 'sk-minimax-second' }),
    })
    const minimaxGatewayKey = await iroha.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST', headers: { 'content-type': 'application/json' }, csrf,
      body: JSON.stringify({ name: 'MiniMax app', scope: [{ providerId: minimaxId }] }),
    })
    const minimaxSecret = ((await minimaxGatewayKey.json()) as { secret: string }).secret
    const keys = await iroha.database.providers.listKeys(minimaxId)
    const at = iroha.clock.now()
    const reading = {
      unit: 'cny', balance: 0, used: null, limit: null, remainingPercent: null,
      plan: null, resetAt: null, scope: { kind: 'provider' }, confidence: 'confirmed',
      diagnostics: { kind: 'credit' },
    }
    await iroha.database.usage.put({
      providerId: minimaxId, visibility: 'authoritative', syncedAt: at, lastSuccessAt: at,
      lastFailureAt: null, lastFailureCode: null, lastFailureMessage: null,
      result: Object.fromEntries(keys.map((key) => [key.id, [reading]])),
    })
    upstream.respondWith(() => Response.json({
      error: { code: 'insufficient_balance', type: 'payment_required', message: 'do not persist me' },
    }, { status: 402 }))

    const response = await iroha.fetch(`/providers/${minimaxId}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${minimaxSecret}` },
      body: JSON.stringify({ model: 'MiniMax-M3', messages: [{ role: 'user', content: 'Hello' }] }),
    })

    expect(response.status).toBe(503)
    expect((await response.json()) as unknown).toMatchObject({ error: { code: 'provider_capacity_exhausted' } })
    expect(upstream.calls.filter((call) => call.method === 'POST')).toHaveLength(2)
    expect((await iroha.database.providers.listKeys(minimaxId)).map((key) => key.health).sort())
      .toEqual(['exhausted', 'exhausted'])
  })

  test('DashScope data inspection failure tries exactly one alternate for streaming calls', async () => {
    upstream.respondWith(() =>
      upstream.calls.length === 1
        ? Response.json({
            error: {
              code: 'data_inspection_failed',
              message: 'Input data may contain inappropriate content.',
            },
            request_id: 'dashscope-request-id',
          }, { status: 400 })
        : Response.json(completion()),
    )

    const response = await iroha.fetch(`/providers/${providerId}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      }),
    })

    expect(response.status).toBe(200)
    expect(upstream.calls).toHaveLength(2)
    expect(upstream.calls[0]?.headers.authorization).not.toBe(upstream.calls[1]?.headers.authorization)
  })

  test('ambiguous network failure does not replay by default', async () => {
    upstream.respondWith(() => {
      throw new TypeError('connection reset')
    })

    const response = await chat()

    expect(response.status).toBe(502)
    expect(upstream.calls).toHaveLength(1)
  })

  test('connection policy can explicitly enable one ambiguous network replay', async () => {
    await iroha.fetch(`/api/v1/admin/providers/${providerId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ retryMaxAttempts: 2, retryAmbiguousNetwork: true }),
      csrf,
    })
    upstream.respondWith(() => {
      if (upstream.calls.length === 1) throw new TypeError('connection reset')
      return Response.json(completion())
    })

    const response = await chat()

    expect(response.status).toBe(200)
    expect(upstream.calls).toHaveLength(2)
    expect(upstream.calls[0]?.headers.authorization).toBe(upstream.calls[1]?.headers.authorization)
    expect(upstream.calls[0]?.headers['idempotency-key']).toBe(upstream.calls[1]?.headers['idempotency-key'])
  })

  test('repeated ambiguous network failures stop after one same-key replay', async () => {
    await iroha.fetch(`/api/v1/admin/providers/${providerId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ retryAmbiguousNetwork: true }),
      csrf,
    })
    upstream.respondWith(() => {
      throw new TypeError('connection reset')
    })

    const response = await chat()

    expect(response.status).toBe(502)
    expect(upstream.calls).toHaveLength(2)
    expect(upstream.calls[0]?.headers.authorization).toBe(upstream.calls[1]?.headers.authorization)
  })

  test('connection attempt maximum stops retry before another credential', async () => {
    await iroha.fetch(`/api/v1/admin/providers/${providerId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ retryMaxAttempts: 1 }),
      csrf,
    })
    upstream.respondWith(() => new Response('invalid', { status: 401 }))

    const response = await chat()

    expect(response.status).toBe(401)
    expect(upstream.calls).toHaveLength(1)
  })
})

function completion() {
  return {
    id: 'chatcmpl-retry',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
  }
}
