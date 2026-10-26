import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { completeSetup, createTestApp, type TestApp } from '../support/app.ts'
import { mockUpstreamTransport } from '../support/inference.ts'
import { fakeTimer } from '../support/timer.ts'

const BASE_URL = 'https://api.example.com/v1'
const MODEL = 'gpt-4o-mini'
const FIRST_KEY = 'sk-first-retry-key'
const SECOND_KEY = 'sk-second-retry-key'

describe('scoped inference retries', () => {
  let iroha: TestApp
  let upstream: ReturnType<typeof mockUpstreamTransport>
  let csrf: string
  let providerId: string
  let providerHandle: string
  let secret: string
  let retryDelays: number[]
  let timer: ReturnType<typeof fakeTimer>

  beforeEach(async () => {
    upstream = mockUpstreamTransport()
    retryDelays = []
    timer = fakeTimer()
    iroha = await createTestApp({
      upstreamTransport: upstream.fetch,
      timer,
      // A round waits out the Key Health cooldown. Advancing the app clock lets a
      // recovered key become eligible without sleeping on the wall clock.
      retrySleep: async (ms) => {
        retryDelays.push(ms)
        timer.advance(ms)
        iroha.clock.advance(ms / 1000)
      },
    })
    csrf = (await completeSetup(iroha)).csrf
    const created = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle: crypto.randomUUID(),
        templateId: 'dashscope',
        displayName: 'Retry',
        baseUrl: BASE_URL,
        keys: [{ upstreamKey: FIRST_KEY }],
      }),
      csrf,
    })
    const provider = (await created.json()) as { id: string; handle: string }
    providerId = provider.id
    providerHandle = provider.handle
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
    // The fixture itself reaches the upstream: this Provider uses the DashScope
    // template, whose Upstream Models are key-scoped, so creating the Provider
    // and adding the second key each discover that key's Key Model
    // Availability. Every assertion below counts inference Attempts only.
    upstream.reset()
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  const chat = () =>
    iroha.fetch(`/providers/${providerHandle}/v1/chat/completions`, {
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

  test('generic unknown-scope 429 keeps trying the pool until the round budget is spent', async () => {
    upstream.respondWith(() => new Response('slow', { status: 429, headers: { 'retry-after': '17' } }))

    const response = await chat()

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('17')
    // One round visits both eligible keys; the attempt budget allows three rounds.
    expect(upstream.calls).toHaveLength(6)
    const keys = await iroha.database.providers.listKeys(providerId)
    // A generic 429 parks each key for a bounded cooldown, never durable exhaustion.
    expect(keys.map((key) => key.health).sort()).toEqual(['cooling_down', 'cooling_down'])
    expect(keys.every((key) => key.retryAfterAt !== null)).toBe(true)
  })

  test('keeps trying the pool and succeeds on a later round', async () => {
    upstream.respondWith(() =>
      upstream.calls.length <= 2 ? new Response('busy', { status: 429 }) : Response.json(completion()),
    )

    const response = await chat()

    expect(response.status).toBe(200)
    expect(upstream.calls).toHaveLength(3)
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

  test('unrecognized 402 tries every eligible key and then stops', async () => {
    await iroha.fetch(`/api/v1/admin/providers/${providerId}/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upstreamKey: 'sk-third-retry-key' }),
      csrf,
    })
    upstream.reset()
    upstream.respondWith(() => new Response('payment required', { status: 402 }))

    const response = await chat()

    expect(response.status).toBe(503)
    expect(upstream.calls).toHaveLength(3)
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

  test.each([
    ['chat/completions', false], ['chat/completions', true],
    ['messages', false], ['messages', true],
  ] as const)('a repeated DashScope 502 reaches a healthy alternate (%s, stream=%s)', async (path, stream) => {
    upstream.respondWith((call) =>
      call.headers.authorization === upstream.calls[0]?.headers.authorization
        ? Response.json({ error: { code: 'upstream_unreachable', type: 'api_error' } }, { status: 502 })
        : Response.json(completion()),
    )

    const response = await iroha.fetch(`/providers/${providerHandle}/v1/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Hello' }], max_tokens: 32, stream }),
    })
    await response.text()

    expect(response.status).toBe(200)
    expect(upstream.calls).toHaveLength(3)
    expect(upstream.calls[0]?.headers.authorization).toBe(upstream.calls[1]?.headers.authorization)
    expect(upstream.calls[2]?.headers.authorization).not.toBe(upstream.calls[0]?.headers.authorization)
    // The healthy key is still untried: do not wait out the failed key's
    // 30-second cooldown before selecting it.
    expect(retryDelays.every((delay) => delay <= 500)).toBe(true)
    const attempts = await iroha.database.requestHistory.getAttempts(response.headers.get('x-request-id')!)
    expect(attempts[0]?.diagnostics).toMatchObject({
      providerCode: 'upstream_unreachable', classification: 'provider_failure', capacityScope: 'key_model',
    })
    expect(attempts.map((attempt) => attempt.status)).toEqual([502, 502, 200])
  })

  test.each([false, true])('repeated 502s remain bounded when every key fails (stream=%s)', async (stream) => {
    await iroha.fetch(`/api/v1/admin/providers/${providerId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, csrf,
      body: JSON.stringify({ retryMaxAttempts: 2 }),
    })
    upstream.respondWith(() => Response.json({ error: { code: 'upstream_unreachable' } }, { status: 502 }))
    const response = await iroha.fetch(`/providers/${providerHandle}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Hello' }], stream }),
    })

    expect(response.status).toBe(502)
    expect(upstream.calls).toHaveLength(8) // Two keys, two attempts each, two rounds.
    expect(new Set(upstream.calls.map((call) => call.headers.authorization)).size).toBe(2)
  })

  test.each([
    ['chat/completions', false, false], ['chat/completions', true, false],
    ['messages', false, false], ['messages', true, false],
    ['chat/completions', false, true], ['chat/completions', true, true],
    ['messages', false, true], ['messages', true, true],
  ] as const)('a slow failure reaches a healthy key within the retry budget (%s, stream=%s, network=%s)', async (path, stream, network) => {
    const settings = await iroha.fetch(`/api/v1/admin/providers/${providerId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, csrf,
      body: JSON.stringify({ totalRetryTimeoutMs: 30_000, retryAmbiguousNetwork: true }),
    })
    expect(settings.status).toBe(200)
    upstream.respondWith((call) => {
      if (call.headers.authorization === upstream.calls[0]?.headers.authorization) {
        timer.advance(20_000)
        if (network) throw new Error('upstream timeout')
        return Response.json({ error: { code: 'upstream_unreachable' } }, { status: 502 })
      }
      timer.advance(1_000)
      return Response.json(completion())
    })

    const response = await iroha.fetch(`/providers/${providerHandle}/v1/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Hello' }], max_tokens: 32, stream }),
    })
    await response.text()

    expect(response.status).toBe(200)
    expect(upstream.calls).toHaveLength(2)
    expect(upstream.calls[0]?.headers.authorization).not.toBe(upstream.calls[1]?.headers.authorization)
    expect(timer.elapsedMs).toBe(21_000)
    expect(retryDelays).toEqual([])
    const attempts = await iroha.database.requestHistory.getAttempts(response.headers.get('x-request-id')!)
    expect(attempts).toHaveLength(2)
    expect(attempts[0]?.keyId).not.toBe(attempts[1]?.keyId)
    expect(attempts[1]?.outcome).toBe('success')
  })

  test.each([false, true])('502 failover stops when the retry time budget is spent (stream=%s)', async (stream) => {
    await iroha.fetch(`/api/v1/admin/providers/${providerId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, csrf,
      body: JSON.stringify({ totalRetryTimeoutMs: 30_000 }),
    })
    upstream.respondWith(() => {
      timer.advance(20_000)
      return Response.json({ error: { code: 'upstream_unreachable' } }, { status: 502 })
    })
    const response = await iroha.fetch(`/providers/${providerHandle}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Hello' }], stream }),
    })

    expect(response.status).toBe(502)
    expect(upstream.calls).toHaveLength(2)
    expect(upstream.calls[0]?.headers.authorization).not.toBe(upstream.calls[1]?.headers.authorization)
  })

  test.each([false, true])('a slow replay remains available when no eligible alternate exists (stream=%s)', async (stream) => {
    const keys = await iroha.database.providers.listKeys(providerId)
    await iroha.database.providers.updateKey(keys[1]!.id, { health: 'disabled' }, iroha.clock.now())
    await iroha.fetch(`/api/v1/admin/providers/${providerId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, csrf,
      body: JSON.stringify({ totalRetryTimeoutMs: 30_000 }),
    })
    upstream.respondWith(() => {
      if (upstream.calls.length === 1) {
        timer.advance(20_000)
        return new Response('unavailable', { status: 502 })
      }
      return Response.json(completion())
    })
    const response = await iroha.fetch(`/providers/${providerHandle}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Hello' }], stream }),
    })
    await response.text()

    expect(response.status).toBe(200)
    expect(upstream.calls).toHaveLength(2)
    expect(upstream.calls[0]?.headers.authorization).toBe(upstream.calls[1]?.headers.authorization)
  })

  test.each([false, true])('an expired retry budget never starts an alternate (stream=%s)', async (stream) => {
    await iroha.fetch(`/api/v1/admin/providers/${providerId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, csrf,
      body: JSON.stringify({ totalRetryTimeoutMs: 30_000 }),
    })
    upstream.respondWith(() => {
      timer.advance(30_000)
      return new Response('unavailable', { status: 502 })
    })
    const response = await iroha.fetch(`/providers/${providerHandle}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Hello' }], stream }),
    })

    expect(response.status).toBe(502)
    expect(upstream.calls).toHaveLength(1)
  })

  test.each(['chat/completions', 'messages'])('slow ambiguous failures still require replay opt-in (%s)', async (path) => {
    await iroha.fetch(`/api/v1/admin/providers/${providerId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, csrf,
      body: JSON.stringify({ totalRetryTimeoutMs: 30_000, retryAmbiguousNetwork: false }),
    })
    upstream.respondWith(() => {
      timer.advance(20_000)
      throw new Error('upstream timeout')
    })
    const response = await iroha.fetch(`/providers/${providerHandle}/v1/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Hello' }], max_tokens: 32 }),
    })

    expect(response.status).toBe(502)
    expect(upstream.calls).toHaveLength(1)
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
      body: JSON.stringify({ handle: crypto.randomUUID(), displayName: 'Retry delay', baseUrl: BASE_URL, keys: [{ upstreamKey: FIRST_KEY }] }),
      csrf,
    })
    const provider = (await created.json()) as { id: string; handle: string }
    providerId = provider.id
    providerHandle = provider.handle
    const key = await iroha.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Retry app', scope: [{ providerId }] }),
      csrf,
    })
    secret = ((await key.json()) as { secret: string }).secret
    upstream.reset()

    const response = await chat()

    expect(response.status).toBe(200)
    expect(delays).toHaveLength(1)
    expect(delays[0]).toBeGreaterThanOrEqual(125)
    expect(delays[0]).toBeLessThanOrEqual(500)
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
        handle: crypto.randomUUID(),
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

    const minimaxHandle = (await iroha.database.providers.getProvider(minimaxId))!.handle
    const response = await iroha.fetch(`/providers/${minimaxHandle}/v1/chat/completions`, {
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

    const handle = (await iroha.database.providers.getProvider(providerId))!.handle
    const response = await iroha.fetch(`/providers/${handle}/v1/chat/completions`, {
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

  describe('a DashScope key whose account is overdue', () => {
    // Observed in production: one key of a 14-key Provider fell into arrears
    // and answered 400 Arrearage. Read as a generic 400 the Request stopped,
    // so every caller that happened to land on that key saw a hard failure
    // while thirteen healthy keys sat idle.
    const arrearage = () => Response.json({
      error: {
        code: 'Arrearage',
        type: 'Arrearage',
        param: null,
        message: 'Access denied, please make sure your account is in good standing.',
      },
      request_id: 'dashscope-request-id',
    }, { status: 400 })

    test('reaches an alternate key on a streaming call', async () => {
      upstream.respondWith(() => (upstream.calls.length === 1 ? arrearage() : Response.json(completion())))

      const response = await iroha.fetch(`/providers/${providerHandle}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Hello' }], stream: true }),
      })

      expect(response.status).toBe(200)
      expect(upstream.calls).toHaveLength(2)
      expect(upstream.calls[0]?.headers.authorization).not.toBe(upstream.calls[1]?.headers.authorization)
    })

    test('parks the overdue key so later Requests never pay for it again', async () => {
      upstream.respondWith(() => (upstream.calls.length === 1 ? arrearage() : Response.json(completion())))

      await chat()

      const keys = await iroha.database.providers.listKeys(providerId)
      expect(keys.map((key) => key.health).sort()).toEqual(['active', 'exhausted'])
      const parked = keys.find((key) => key.health === 'exhausted')
      expect(parked).toMatchObject({ healthScope: 'key', healthScopeId: parked?.id })
      expect(parked?.retryAfterAt).not.toBeNull()
    })

    test('records why the Attempt failed without retaining the message', async () => {
      upstream.respondWith(() => (upstream.calls.length === 1 ? arrearage() : Response.json(completion())))

      const response = await chat()
      const requestId = response.headers.get('x-request-id')!
      const attempts = await iroha.database.requestHistory.getAttempts(requestId)

      expect(attempts[0]?.diagnostics).toMatchObject({
        status: 400,
        providerCode: 'Arrearage',
        classification: 'payment_required',
        capacityScope: 'key',
      })
      expect(JSON.stringify(attempts[0]?.diagnostics)).not.toContain('good standing')
    })

    test('stops when the overdue key is the only one left', async () => {
      // Each refusal is key-scoped. Once both keys are parked, resolution
      // reports that no eligible key remains without another upstream call.
      upstream.respondWith(arrearage)

      const response = await chat()

      expect(response.status).toBe(503)
      expect(upstream.calls).toHaveLength(2)
    })
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

  test('a same-key attempt setting of one does not prevent credential failover', async () => {
    await iroha.fetch(`/api/v1/admin/providers/${providerId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ retryMaxAttempts: 1 }),
      csrf,
    })
    upstream.respondWith(() => new Response('invalid', { status: 401 }))

    const response = await chat()

    expect(response.status).toBe(503)
    expect(upstream.calls).toHaveLength(2)
  })
})

describe('key-and-model scoped Key Health', () => {
  // Observed in production: Mistral rate-limits per model, so one model's 429
  // cooled the key for every model and its siblings failed as
  // `model_keys_unavailable` although they would have succeeded.
  const MEDIUM = 'mistral-medium-latest'
  const CODESTRAL = 'codestral-latest'
  const MINISTRAL = 'ministral-8b-latest'
  const SMALL = 'mistral-small-latest'

  let iroha: TestApp
  let upstream: ReturnType<typeof mockUpstreamTransport>
  let csrf: string
  let secret: string
  let handle: string
  let providerId: string

  /** One key, one Attempt per Request: every call below lands on the same key. */
  const createProvider = async (templateId?: string) => {
    const created = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST', headers: { 'content-type': 'application/json' }, csrf,
      body: JSON.stringify({
        handle: crypto.randomUUID(),
        ...(templateId === undefined ? {} : { templateId }),
        displayName: 'Per model',
        baseUrl: BASE_URL,
        keys: [{ upstreamKey: FIRST_KEY }],
      }),
    })
    const provider = (await created.json()) as { id: string; handle: string }
    providerId = provider.id
    handle = provider.handle
    await iroha.fetch(`/api/v1/admin/providers/${providerId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, csrf,
      body: JSON.stringify({ retryMaxAttempts: 1 }),
    })
    const key = await iroha.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST', headers: { 'content-type': 'application/json' }, csrf,
      body: JSON.stringify({ name: 'Per model app', scope: [{ providerId }] }),
    })
    secret = ((await key.json()) as { secret: string }).secret
    upstream.reset()
  }

  beforeEach(async () => {
    upstream = mockUpstreamTransport()
    iroha = await createTestApp({ upstreamTransport: upstream.fetch, retrySleep: async () => {} })
    csrf = (await completeSetup(iroha)).csrf
    await createProvider()
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  const chat = async (model: string) => {
    const response = await iroha.fetch(`/providers/${handle}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Hello' }] }),
    })
    await response.text()
    return response
  }
  const modelOf = (call: { body: string | null }) => (JSON.parse(call.body ?? '{}') as { model?: string }).model
  /** Fails the listed models with `failure()`; every other model succeeds. */
  const failing = (models: readonly string[], failure: () => Response) => {
    upstream.respondWith((call) => {
      const model = modelOf(call)
      return model !== undefined && models.includes(model)
        ? failure()
        : Response.json({ ...completion(), model })
    })
  }
  const storedKey = async () => (await iroha.database.providers.listKeys(providerId))[0]!
  const rateLimited = () => Response.json(
    { error: { message: 'Requests rate limit exceeded', type: 'rate_limited' } },
    { status: 429, headers: { 'retry-after': '60' } },
  )
  const badGateway = () => Response.json({ error: { message: 'Bad gateway' } }, { status: 502 })
  const forbidden = () => Response.json({ error: { message: 'Forbidden' } }, { status: 403 })

  test.each([
    ['429', rateLimited],
    ['502', badGateway],
    ['403 without an account condition', forbidden],
  ] as const)('a %s on one model cools only that key-and-model pair', async (_, failure) => {
    failing([MEDIUM], failure)

    expect((await chat(MEDIUM)).status).not.toBe(200)
    expect(await storedKey()).toMatchObject({
      health: 'cooling_down', healthScope: 'key_model', healthModel: MEDIUM,
    })

    // The same key still serves its other models…
    expect((await chat(CODESTRAL)).status).toBe(200)
    expect(upstream.calls.map(modelOf)).toEqual([MEDIUM, CODESTRAL])
    // …and a success on another model does not lift the cooled model's cooldown.
    expect(await storedKey()).toMatchObject({ healthScope: 'key_model', healthModel: MEDIUM })
    // The cooled pair is skipped without another Attempt until it expires.
    expect((await chat(MEDIUM)).status).toBe(503)
    expect(upstream.calls).toHaveLength(2)
  })

  test('each cooled model stays skipped while a later model takes the persisted claim', async () => {
    failing([MEDIUM, CODESTRAL], rateLimited)

    await chat(MEDIUM)
    await chat(CODESTRAL)
    expect(await storedKey()).toMatchObject({ healthScope: 'key_model', healthModel: CODESTRAL })

    expect((await chat(MEDIUM)).status).toBe(503)
    expect((await chat(SMALL)).status).toBe(200)
    expect(upstream.calls.map(modelOf)).toEqual([MEDIUM, CODESTRAL, SMALL])
  })

  test.each([
    ['429', rateLimited],
    ['5xx', badGateway],
  ] as const)('the same %s on three distinct models escalates to the whole key', async (_, failure) => {
    failing([MEDIUM, CODESTRAL, MINISTRAL], failure)

    await chat(MEDIUM)
    await chat(CODESTRAL)
    expect(await storedKey()).toMatchObject({ healthScope: 'key_model', healthModel: CODESTRAL })
    await chat(MINISTRAL)

    const key = await storedKey()
    expect(key).toMatchObject({ health: 'cooling_down', healthScope: 'key', healthModel: null })
    expect(key.retryAfterAt).not.toBeNull()
    // A model that never failed is no longer routed to the key.
    expect((await chat(SMALL)).status).toBe(503)
    expect(upstream.calls).toHaveLength(3)
  })

  test('a Provider down for every model reaches the whole key within the window', async () => {
    failing([MEDIUM, CODESTRAL, MINISTRAL], () => new Response('internal error', { status: 500 }))

    await chat(MEDIUM)
    iroha.clock.advance(60)
    await chat(CODESTRAL)
    iroha.clock.advance(60)
    await chat(MINISTRAL)

    expect(await storedKey()).toMatchObject({ health: 'cooling_down', healthScope: 'key' })
  })

  test('failures outside the escalation window or of different kinds do not escalate', async () => {
    failing([MEDIUM, CODESTRAL], rateLimited)
    await chat(MEDIUM)
    await chat(CODESTRAL)
    failing([MINISTRAL], badGateway)
    await chat(MINISTRAL)
    expect(await storedKey()).toMatchObject({ healthScope: 'key_model', healthModel: MINISTRAL })

    // Five minutes on, the earlier 429s no longer count toward a third.
    iroha.clock.advance(5 * 60 + 1)
    failing([SMALL], rateLimited)
    await chat(SMALL)
    expect(await storedKey()).toMatchObject({ healthScope: 'key_model', healthModel: SMALL })
  })

  test.each([
    ['401', () => new Response('invalid', { status: 401 }), 'invalid_authentication'],
    ['403 naming an account condition', () => Response.json(
      { error: { message: 'please complete your profile via email verification' } },
      { status: 403 },
    ), 'cooling_down'],
    ['429 naming spent quota', () => Response.json(
      { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota' } },
      { status: 429 },
    ), 'cooling_down'],
  ] as const)('a %s speaks for the whole key at once', async (_, failure, health) => {
    failing([MEDIUM], failure)

    await chat(MEDIUM)

    expect(await storedKey()).toMatchObject({ health, healthScope: 'key', healthModel: null })
    expect((await chat(CODESTRAL)).status).toBe(503)
    expect(upstream.calls).toHaveLength(1)
  })

  test('a key-and-model cooldown expires into a controlled trial that recovers the key', async () => {
    failing([MEDIUM], rateLimited)
    await chat(MEDIUM)
    expect((await chat(MEDIUM)).status).toBe(503)

    iroha.clock.advance(61)
    failing([], rateLimited)

    expect((await chat(MEDIUM)).status).toBe(200)
    expect(await storedKey()).toMatchObject({ health: 'active', healthScope: 'key', healthModel: null })
    expect(upstream.calls.map(modelOf)).toEqual([MEDIUM, MEDIUM])
  })

  test('an escalated key recovers through the same expiry and trial', async () => {
    failing([MEDIUM, CODESTRAL, MINISTRAL], rateLimited)
    await chat(MEDIUM)
    await chat(CODESTRAL)
    await chat(MINISTRAL)
    expect(await storedKey()).toMatchObject({ healthScope: 'key' })

    iroha.clock.advance(61)
    failing([], rateLimited)

    expect((await chat(SMALL)).status).toBe(200)
    expect(await storedKey()).toMatchObject({ health: 'active' })
    // The success discarded the expired failures: one more 429 cools one model.
    failing([MEDIUM], rateLimited)
    await chat(MEDIUM)
    expect(await storedKey()).toMatchObject({ healthScope: 'key_model', healthModel: MEDIUM })
  })

  test('a precise Inference Adapter classification still speaks for the whole key', async () => {
    // Z.ai answers a credential issued for another Z.ai product with 429 code
    // 1315. Its adapter reads that as a key-scoped refusal, which must win over
    // the generic per-model reading of a 429.
    await createProvider('zai')
    failing([MEDIUM], () => Response.json({ error: { code: '1315', message: 'wrong product' } }, { status: 429 }))

    await chat(MEDIUM)

    expect(await storedKey()).toMatchObject({ health: 'cooling_down', healthScope: 'key', healthModel: null })
    expect((await chat(CODESTRAL)).status).toBe(503)
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
