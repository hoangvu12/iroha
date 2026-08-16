import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import OpenAI from 'openai'
import { appFetch, completeSetup, createTestApp, type TestApp } from '../support/app.ts'
import { controlledSse, mockUpstreamTransport, sseDone, sseEvent, sseResponse } from '../support/inference.ts'

const BASE_URL = 'https://api.example.com/v1'
const UPSTREAM_KEY = 'sk-global-chat-test'
const PROVIDER_HANDLE = 'global-chat'

describe('global Chat Completions', () => {
  let iroha: TestApp
  let csrf: string
  let upstream: ReturnType<typeof mockUpstreamTransport>
  let providerId: string
  let secret: string

  beforeEach(async () => {
    upstream = mockUpstreamTransport()
    iroha = await createTestApp({ upstreamTransport: upstream.fetch })
    csrf = (await completeSetup(iroha)).csrf
    providerId = await createProvider()
    secret = await createKey([{ providerId }])
  })

  afterEach(async () => await iroha.dispose())

  test('the official OpenAI client forwards the exact nested model and qualifies the served model', async () => {
    upstream.respondWith(() => Response.json({
      id: 'chatcmpl-global', object: 'chat.completion', created: 1, model: 'served/alias',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
    }))
    const client = new OpenAI({ apiKey: secret, baseURL: 'http://iroha.test/v1', fetch: appFetch(iroha.app), maxRetries: 0 })

    const completion = await client.chat.completions.create({
      model: `${PROVIDER_HANDLE}/openai/gpt-4o`, messages: [{ role: 'user', content: 'Hello' }],
    })
    expect(completion.model).toBe(`${PROVIDER_HANDLE}/served/alias`)
    const forwarded = JSON.parse(upstream.calls[0]!.body ?? '{}') as { model: string }
    expect(forwarded.model).toBe('openai/gpt-4o')
    expect(upstream.calls[0]!.url).toBe(`${BASE_URL}/chat/completions`)
    expect(upstream.calls[0]!.headers.authorization).toBe(`Bearer ${UPSTREAM_KEY}`)
  })

  test('falls back to the requested Qualified Model ID when upstream omits model', async () => {
    upstream.respondWith(() => Response.json({ id: 'chatcmpl-fallback', object: 'chat.completion', choices: [] }))
    const requested = `${PROVIDER_HANDLE}/vendor/future-model`
    const response = await chat({ model: requested, messages: [] })
    expect(response.status).toBe(200)
    expect(((await response.json()) as { model: string }).model).toBe(requested)
  })

  test('qualifies every streaming chunk while preserving DONE', async () => {
    upstream.respondWith(() => sseResponse([
      sseEvent(JSON.stringify({ id: 'one', object: 'chat.completion.chunk', model: 'served-model', choices: [] })),
      sseEvent(JSON.stringify({ id: 'two', object: 'chat.completion.chunk', choices: [] })),
      sseDone(),
    ]))
    const requested = `${PROVIDER_HANDLE}/nested/requested`
    const response = await chat({ model: requested, messages: [], stream: true })
    const text = await response.text()
    expect(text).toContain(`"model":"${PROVIDER_HANDLE}/served-model"`)
    expect(text).toContain(`"model":"${requested}"`)
    expect(text).toContain('data: [DONE]')
  })

  test('the official OpenAI client consumes globally qualified streaming chunks', async () => {
    upstream.respondWith(() => sseResponse([
      sseEvent(JSON.stringify({ id: 'sdk-stream', object: 'chat.completion.chunk', created: 1, model: 'served-stream', choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }] })),
      sseDone(),
    ]))
    const client = new OpenAI({ apiKey: secret, baseURL: 'http://iroha.test/v1', fetch: appFetch(iroha.app), maxRetries: 0 })
    const stream = await client.chat.completions.create({ model: `${PROVIDER_HANDLE}/nested/model`, messages: [], stream: true })
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    expect(chunks[0]?.model).toBe(`${PROVIDER_HANDLE}/served-stream`)
    expect(chunks[0]?.choices[0]?.delta.content).toBe('Hi')
  })

  test('retains retry and request-history behavior through the global route', async () => {
    let attempts = 0
    upstream.respondWith(() => {
      attempts += 1
      return attempts === 1
        ? new Response('{"error":{"message":"temporary"}}', { status: 503 })
        : Response.json({ id: 'recovered', object: 'chat.completion', model: 'recovered-model', choices: [] })
    })
    const response = await chat({ model: `${PROVIDER_HANDLE}/nested/retry`, messages: [] })
    expect(response.status).toBe(200)
    expect(upstream.calls).toHaveLength(2)
    const requestId = response.headers.get('x-request-id')
    const history = await iroha.fetch(`/api/v1/admin/requests/${requestId}`)
    expect(history.status).toBe(200)
    expect(((await history.json()) as { attempts: unknown[] }).attempts).toHaveLength(2)
  })

  test('propagates caller cancellation through the global stream transform', async () => {
    upstream.respondWith((call) => {
      const held = controlledSse(call)
      held.enqueue(sseEvent(JSON.stringify({ object: 'chat.completion.chunk', model: 'served', choices: [] })))
      return new Response(held.stream, { headers: { 'content-type': 'text/event-stream' } })
    })
    const controller = new AbortController()
    const response = await chat({ model: `${PROVIDER_HANDLE}/nested/cancel`, messages: [], stream: true }, secret, controller.signal)
    const reading = response.text()
    await Bun.sleep(0)
    expect(upstream.calls[0]?.signal?.aborted).toBe(false)
    controller.abort()
    expect(upstream.calls[0]?.signal?.aborted).toBe(true)
    await reading
  })

  test('rejects malformed IDs, invalid keys, inaccessible Providers, and denied models before upstream', async () => {
    const malformed = await chat({ model: 'unqualified', messages: [] })
    expect(malformed.status).toBe(400)
    expect(((await malformed.json()) as { error: { code: string } }).error.code).toBe('invalid_model_id')

    const invalidHandle = await chat({ model: 'INVALID/model', messages: [] })
    expect(invalidHandle.status).toBe(400)
    expect(((await invalidHandle.json()) as { error: { code: string } }).error.code).toBe('invalid_provider_handle')

    const invalid = await chat({ model: `${PROVIDER_HANDLE}/model`, messages: [] }, 'gk_absent.wrong')
    expect(invalid.status).toBe(401)

    const invalidKeyAbsentHandle = await chat({ model: 'absent/model', messages: [] }, 'gk_absent.wrong')
    expect(invalidKeyAbsentHandle.status).toBe(401)

    const absent = await chat({ model: 'absent/model', messages: [] })
    expect(absent.status).toBe(403)
    expect(((await absent.json()) as { error: { code: string } }).error.code).toBe('provider_not_allowed')

    const legacyId = await chat({ model: `${providerId}/model`, messages: [] })
    expect(legacyId.status).toBe(400)
    expect(((await legacyId.json()) as { error: { code: string } }).error.code).toBe('invalid_provider_handle')

    const restricted = await createKey([{ providerId, models: ['allowed'] }])
    const denied = await chat({ model: `${PROVIDER_HANDLE}/denied`, messages: [] }, restricted)
    expect(denied.status).toBe(403)
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe('model_not_allowed')
    expect(upstream.calls).toHaveLength(0)
  })

  async function createProvider(): Promise<string> {
    const response = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Global chat', handle: PROVIDER_HANDLE, baseUrl: BASE_URL, keys: [{ upstreamKey: UPSTREAM_KEY }] }), csrf,
    })
    return ((await response.json()) as { id: string }).id
  }

  async function createKey(scope: unknown[]): Promise<string> {
    const response = await iroha.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Global chat client', scope }), csrf,
    })
    return ((await response.json()) as { secret: string }).secret
  }

  function chat(body: unknown, token = secret, signal?: AbortSignal): Promise<Response> {
    return iroha.fetch('/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    })
  }
})
