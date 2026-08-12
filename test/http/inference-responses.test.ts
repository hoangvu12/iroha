import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { completeSetup, createTestApp, type TestApp } from '../support/app.ts'
import {
  controlledSse,
  mockUpstreamTransport,
  sseEvent,
  sseResponse,
  type RecordedUpstreamCall,
} from '../support/inference.ts'

const UPSTREAM_KEY = 'sk-upstream-secret-value-for-tests'
const BASE_URL = 'https://api.example.com/v1'
const MODEL = 'gpt-4o-mini'

describe('provider-scoped Responses API', () => {
  let iroha: TestApp
  let csrf: string
  let upstream: ReturnType<typeof mockUpstreamTransport>
  let path: string
  let secret: string

  beforeEach(async () => {
    upstream = mockUpstreamTransport()
    iroha = await createTestApp({ upstreamTransport: upstream.fetch })
    csrf = (await completeSetup(iroha)).csrf
    const connection = await createConnection(iroha, csrf)
    path = `/providers/${connection.id}/v1/responses`
    secret = await createGatewayKey(iroha, csrf, connection.id)
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  const respond = (
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ) =>
    iroha.fetch(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
        ...headers,
      },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    })

  test('preserves stored state, tools, structured output, extensions, and idempotency', async () => {
    upstream.respondWith((call) =>
      Response.json({ id: 'resp_mock', object: 'response', model: MODEL, received: call.body }),
    )
    const body = {
      model: MODEL,
      input: 'Say hello',
      store: false,
      tools: [{ type: 'function', name: 'weather', parameters: { type: 'object' } }],
      text: { format: { type: 'json_schema', name: 'answer', schema: { type: 'object' } } },
      provider_extension: { cache: 'ephemeral' },
    }

    const response = await respond(body, { 'idempotency-key': 'response-attempt-123' })

    expect(response.status).toBe(200)
    expect(response.headers.get('x-request-id')).toMatch(/^req_/)
    expect(upstream.calls).toHaveLength(1)
    expect(upstream.calls[0]?.url).toBe(`${BASE_URL}/responses`)
    expect(upstream.calls[0]?.headers.authorization).toBe(`Bearer ${UPSTREAM_KEY}`)
    expect(upstream.calls[0]?.headers['idempotency-key']).toBe('response-attempt-123')
    expect(JSON.parse(upstream.calls[0]?.body ?? '{}')).toEqual(body)
  })

  test('preserves Responses stream events in exact order', async () => {
    const events = [
      sseEvent(JSON.stringify({ type: 'response.created', sequence_number: 0 })),
      sseEvent(
        JSON.stringify({
          type: 'response.output_text.delta',
          sequence_number: 1,
          output_index: 0,
          content_index: 0,
          delta: 'Hello',
        }),
      ),
      sseEvent(JSON.stringify({ type: 'response.completed', sequence_number: 2 })),
    ]
    upstream.respondWith(() => sseResponse(events))

    const response = await respond({ model: MODEL, input: 'Hello', stream: true })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(await response.text()).toBe(events.join(''))
    expect(upstream.calls[0]?.url).toBe(`${BASE_URL}/responses`)
  })

  test('uses the same sanitized error contract without retrying', async () => {
    upstream.respondWith(() =>
      new Response('unsafe upstream detail with sk-provider-secret', { status: 503 }),
    )

    const response = await respond({ model: MODEL, input: 'Hello' })
    const text = await response.text()

    expect(response.status).toBe(503)
    expect(text).not.toContain('unsafe upstream detail')
    expect(text).not.toContain('sk-provider-secret')
    expect(JSON.parse(text).error.code).toBe('upstream_unavailable')
    expect(upstream.calls).toHaveLength(2)
  })

  test('caller cancellation aborts a buffered upstream response', async () => {
    upstream.respondWith(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          })
        }),
    )
    const controller = new AbortController()
    const pending = respond({ model: MODEL, input: 'Hello' }, {}, controller.signal)
    pending.catch(() => {})
    await waitForCall(upstream.calls)

    controller.abort()

    await pending.then(() => 'closed', () => 'aborted')
    expect(upstream.calls[0]?.signal?.aborted).toBe(true)
  })

  test('downstream stream cancellation aborts upstream after bytes begin', async () => {
    let controlled: ReturnType<typeof controlledSse> | null = null
    upstream.respondWith((call) => {
      controlled = controlledSse(call)
      return new Response(controlled.stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const response = await respond({ model: MODEL, input: 'Hello', stream: true })
    controlled!.enqueue(sseEvent(JSON.stringify({ type: 'response.created' })))
    const reader = response.body!.getReader()
    await reader.read()

    await reader.cancel()

    expect(upstream.calls[0]?.signal?.aborted).toBe(true)
  })
})

async function createConnection(iroha: TestApp, csrf: string): Promise<{ id: string }> {
  const response = await iroha.fetch('/api/v1/admin/provider-connections', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      displayName: 'Responses example',
      baseUrl: BASE_URL,
      upstreamKey: UPSTREAM_KEY,
    }),
    csrf,
  })
  if (response.status !== 201) throw new Error(`Connection create failed: ${await response.text()}`)
  return (await response.json()) as { id: string }
}

async function createGatewayKey(iroha: TestApp, csrf: string, connectionId: string): Promise<string> {
  const response = await iroha.fetch('/api/v1/admin/gateway-keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Responses client', scope: [{ connectionId }] }),
    csrf,
  })
  if (response.status !== 201) throw new Error(`Gateway Key create failed: ${await response.text()}`)
  return ((await response.json()) as { secret: string }).secret
}

async function waitForCall(calls: RecordedUpstreamCall[]): Promise<void> {
  for (let index = 0; index < 100 && calls.length === 0; index++) await Promise.resolve()
  expect(calls).toHaveLength(1)
}
