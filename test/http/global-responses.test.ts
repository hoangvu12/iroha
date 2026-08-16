import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import OpenAI from 'openai'
import { appFetch, completeSetup, createTestApp, type TestApp } from '../support/app.ts'
import { controlledSse, mockUpstreamTransport, sseDone, sseEvent, sseResponse } from '../support/inference.ts'

const BASE_URL = 'https://api.example.com/v1'
const UPSTREAM_KEY = 'sk-global-responses'
const PROVIDER_HANDLE = 'global-responses'

describe('global Responses', () => {
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

  test('the official OpenAI client forwards nested models, tools, structured output, and unknown fields', async () => {
    upstream.respondWith(() => Response.json(responseBody('served/response')))
    const client = new OpenAI({ apiKey: secret, baseURL: 'http://iroha.test/v1', fetch: appFetch(iroha.app), maxRetries: 0 })
    const response = await client.responses.create({
      model: `${PROVIDER_HANDLE}/openai/gpt-4o`, input: 'Hello',
      tools: [{ type: 'function', name: 'weather', parameters: { type: 'object', properties: {} }, strict: true }],
      text: { format: { type: 'json_schema', name: 'answer', schema: { type: 'object' }, strict: true } },
      vendor_extension: { retained: true },
    } as never)
    expect(response.model).toBe(`${PROVIDER_HANDLE}/served/response`)
    const sent = JSON.parse(upstream.calls[0]!.body ?? '{}') as Record<string, unknown>
    expect(sent.model).toBe('openai/gpt-4o')
    expect(sent.tools).toBeDefined()
    expect(sent.text).toBeDefined()
    expect(sent.vendor_extension).toEqual({ retained: true })
    expect(upstream.calls[0]!.url).toBe(`${BASE_URL}/responses`)
  })

  test('uses the requested Qualified Model ID when a buffered response omits model', async () => {
    upstream.respondWith(() => Response.json({ ...responseBody('unused'), model: undefined }))
    const requested = `${PROVIDER_HANDLE}/nested/fallback`
    const response = await call({ model: requested, input: 'Hello' })
    expect(((await response.json()) as { model: string }).model).toBe(requested)
  })

  test('qualifies models inside official Responses stream events and preserves model-less deltas', async () => {
    upstream.respondWith(() => sseResponse([
      sseEvent(JSON.stringify({ type: 'response.created', response: responseBody('served-stream'), sequence_number: 0 })),
      sseEvent(JSON.stringify({ type: 'response.output_text.delta', delta: 'Hello', sequence_number: 1 })),
      sseEvent(JSON.stringify({ type: 'response.completed', response: { ...responseBody('unused'), model: undefined }, sequence_number: 2 })),
      sseDone(),
    ]))
    const requested = `${PROVIDER_HANDLE}/nested/requested`
    const client = new OpenAI({ apiKey: secret, baseURL: 'http://iroha.test/v1', fetch: appFetch(iroha.app), maxRetries: 0 })
    const stream = await client.responses.create({ model: requested, input: 'Hello', stream: true })
    const events: unknown[] = []
    for await (const event of stream) events.push(event)
    expect((events[0] as { response: { model: string } }).response.model).toBe(`${PROVIDER_HANDLE}/served-stream`)
    expect((events[1] as Record<string, unknown>)).not.toHaveProperty('model')
    expect((events[2] as { response: { model: string } }).response.model).toBe(requested)
  })

  test('retries through the shared pipeline and retains request history', async () => {
    let count = 0
    upstream.respondWith(() => ++count === 1 ? new Response('temporary', { status: 503 }) : Response.json(responseBody('recovered')))
    const response = await call({ model: `${PROVIDER_HANDLE}/nested/retry`, input: 'Hello' })
    expect(response.status).toBe(200)
    expect(upstream.calls).toHaveLength(2)
    const history = await iroha.fetch(`/api/v1/admin/requests/${response.headers.get('x-request-id')}`)
    expect(((await history.json()) as { attempts: unknown[] }).attempts).toHaveLength(2)
  })

  test('retains existing adapter error translation after authorization', async () => {
    upstream.respondWith(() => new Response('{"error":{"message":"unsafe detail"}}', { status: 400 }))
    const response = await call({ model: `${PROVIDER_HANDLE}/model`, input: 'Hello' })
    expect(response.status).toBe(400)
    const text = await response.text()
    expect(text).toContain('upstream_bad_request')
    expect(text).not.toContain('unsafe detail')
    expect(upstream.calls).toHaveLength(1)
  })

  test('propagates streaming cancellation to upstream', async () => {
    upstream.respondWith((recorded) => {
      const held = controlledSse(recorded)
      held.enqueue(sseEvent(JSON.stringify({ type: 'response.created', response: responseBody('served') })))
      return new Response(held.stream, { headers: { 'content-type': 'text/event-stream' } })
    })
    const controller = new AbortController()
    const response = await call({ model: `${PROVIDER_HANDLE}/model`, input: 'Hello', stream: true }, secret, controller.signal)
    const reading = response.text()
    await Bun.sleep(0)
    controller.abort()
    expect(upstream.calls[0]?.signal?.aborted).toBe(true)
    await reading
  })

  test('rejects malformed, unauthorized, inaccessible, and model-denied requests before upstream', async () => {
    expect((await call({ model: 'bad', input: 'x' })).status).toBe(400)
    expect((await call({ model: `${PROVIDER_HANDLE}/ok`, input: 'x' }, 'gk_absent.wrong')).status).toBe(401)
    expect((await call({ model: 'absent/ok', input: 'x' })).status).toBe(403)
    const restricted = await createKey([{ providerId, models: ['allowed'] }])
    expect((await call({ model: `${PROVIDER_HANDLE}/denied`, input: 'x' }, restricted)).status).toBe(403)
    expect(upstream.calls).toHaveLength(0)
  })

  async function createProvider(): Promise<string> {
    const response = await iroha.fetch('/api/v1/admin/providers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'Global Responses', handle: PROVIDER_HANDLE, baseUrl: BASE_URL, keys: [{ upstreamKey: UPSTREAM_KEY }] }), csrf })
    return ((await response.json()) as { id: string }).id
  }
  async function createKey(scope: unknown[]): Promise<string> {
    const response = await iroha.fetch('/api/v1/admin/gateway-keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Responses client', scope }), csrf })
    return ((await response.json()) as { secret: string }).secret
  }
  function call(body: unknown, token = secret, signal?: AbortSignal): Promise<Response> {
    return iroha.fetch('/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }) })
  }
})

function responseBody(model: string) {
  return { id: 'resp_global', object: 'response', created_at: 1, status: 'completed', model, output: [], error: null, incomplete_details: null, instructions: null, tools: [], tool_choice: 'auto', parallel_tool_calls: true, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
}
