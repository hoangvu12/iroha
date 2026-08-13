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
      body: JSON.stringify({ displayName: 'Retry', baseUrl: BASE_URL, upstreamKey: FIRST_KEY }),
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

  test('unknown-scope 429 tries at most one alternate and leaves a durable retry time', async () => {
    upstream.respondWith(() => new Response('slow', { status: 429, headers: { 'retry-after': '17' } }))

    const response = await chat()

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('17')
    expect(upstream.calls).toHaveLength(2)
    const keys = await iroha.database.providers.listKeys(providerId)
    expect(keys.filter((key) => key.health === 'exhausted')).toHaveLength(2)
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
      body: JSON.stringify({ displayName: 'Retry delay', baseUrl: BASE_URL, upstreamKey: FIRST_KEY }),
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

  test('ambiguous network failure does not replay by default', async () => {
    upstream.respondWith(() => {
      throw new TypeError('connection reset')
    })

    const response = await chat()

    expect(response.status).toBe(502)
    expect(upstream.calls).toHaveLength(1)
  })

  test('connection policy can explicitly allow one ambiguous network replay', async () => {
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
