import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  completeSetup,
  createTestApp,
  type TestApp,
} from '../support/app.ts'
import {
  controlledSse,
  mockUpstreamTransport,
  type RecordedUpstreamCall,
  sseDone,
  sseEvent,
  sseResponse,
} from '../support/inference.ts'
import { fakeTimer, type FakeTimer } from '../support/timer.ts'

const UPSTREAM_KEY = 'sk-upstream-secret-value-for-tests'
const BASE_URL = 'https://api.example.com/v1'
const MODEL = 'gpt-4o-mini'

interface ConnectionBody {
  id: string
  handle: string
  displayName: string
  keys: { id: string; health: string }[]
}

const STREAM = {
  id: 'chatcmpl-stream-test',
  object: 'chat.completion.chunk',
  created: 1_700_000_000,
  model: MODEL,
}

function chunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return JSON.stringify({
    ...STREAM,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })
}

const FIRST_CHUNK = chunk({ role: 'assistant', content: '' }, null)
const HELLO_CHUNK = chunk({ content: 'Hello' }, null)
const STOP_CHUNK = chunk({}, 'stop')

function streamBody(): Record<string, unknown> {
  return {
    model: MODEL,
    messages: [{ role: 'user', content: 'Say hello' }],
    stream: true,
  }
}

function completionBody(): Record<string, unknown> {
  return {
    model: MODEL,
    messages: [{ role: 'user', content: 'Say hello' }],
  }
}

describe('provider-scoped streaming Chat Completions', () => {
  let iroha: TestApp
  let csrf: string
  let upstream: ReturnType<typeof mockUpstreamTransport>
  let timer: FakeTimer
  let connection: ConnectionBody
  let path: string
  let key: { secret: string }

  beforeEach(async () => {
    upstream = mockUpstreamTransport()
    timer = fakeTimer()
    iroha = await createTestApp({
      upstreamTransport: upstream.fetch,
      timer,
      streamingTimeouts: { streamingHeaderMs: 1_000, streamingIdleMs: 2_000 },
    })
    csrf = (await completeSetup(iroha)).csrf
    ;({ connection, key } = await connect())
    path = `/providers/${connection.handle}/v1/chat/completions`
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  const connect = async (): Promise<{ connection: ConnectionBody; key: { secret: string } }> => {
    const created = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle: crypto.randomUUID(),
        displayName: 'Streaming example',
        baseUrl: BASE_URL,
        keys: [{ upstreamKey: UPSTREAM_KEY }],
      }),
      csrf,
    })
    if (created.status !== 201) {
      throw new Error(`Connection create failed with ${created.status}: ${await created.text()}`)
    }
    const connectionBody = (await created.json()) as ConnectionBody
    const keyResponse = await iroha.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Streaming app',
        scope: [{ providerId: connectionBody.id }],
      }),
      csrf,
    })
    if (keyResponse.status !== 201) {
      throw new Error(`Key create failed with ${keyResponse.status}: ${await keyResponse.text()}`)
    }
    return { connection: connectionBody, key: (await keyResponse.json()) as { secret: string } }
  }

  const chat = (
    token: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ) =>
    iroha.fetch(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...headers,
      },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    })

  describe('streaming detection and passthrough', () => {
    test('streams the upstream SSE through unchanged on a streaming request', async () => {
      const raw = `${sseEvent(FIRST_CHUNK)}${sseEvent(HELLO_CHUNK)}${sseEvent(STOP_CHUNK)}${sseDone()}`
      upstream.respondWith(() => sseResponse([sseEvent(FIRST_CHUNK), sseEvent(HELLO_CHUNK), sseEvent(STOP_CHUNK), sseDone()]))

      const response = await chat(key.secret, streamBody())

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/event-stream')
      expect(response.headers.get('x-request-id')).toMatch(/^req_/)
      expect(await response.text()).toBe(raw)
    })

    test('reaches the Provider with the exact model, stream flag, and safe headers', async () => {
      upstream.respondWith(() => sseResponse([sseEvent(FIRST_CHUNK), sseDone()]))
      const baseline = upstream.calls.length

      const response = await chat(key.secret, streamBody(), {
        cookie: 'session=secret-cookie',
        'x-forwarded-for': '203.0.113.9',
        'x-custom-header': 'forward-me',
      })
      expect(response.status).toBe(200)
      await response.text()

      expect(upstream.calls.length - baseline).toBe(1)
      const forwarded = upstream.calls[baseline]!
      expect(forwarded.url).toBe(`${BASE_URL}/chat/completions`)
      expect(forwarded.method).toBe('POST')
      expect(forwarded.headers.authorization).toBe(`Bearer ${UPSTREAM_KEY}`)
      expect(JSON.stringify(forwarded.headers)).not.toContain(key.secret)
      expect(forwarded.headers['cookie']).toBeUndefined()
      expect(forwarded.headers['x-forwarded-for']).toBeUndefined()
      expect(forwarded.headers['x-custom-header']).toBe('forward-me')

      const sent = JSON.parse(forwarded.body ?? '{}') as { model: string; stream: boolean }
      expect(sent.model).toBe(MODEL)
      expect(sent.stream).toBe(true)
    })

    test('a request without stream: true stays on the buffered path', async () => {
      const baseline = upstream.calls.length
      const response = await chat(key.secret, completionBody())

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('application/json')
      const completion = (await response.json()) as { object: string }
      expect(completion.object).toBe('chat.completion')
      expect(upstream.calls.length - baseline).toBe(1)
    })

    test('a Provider that ignores stream: true is delivered as its finished body', async () => {
      upstream.respondWith(() =>
        new Response(JSON.stringify({ id: 'chatcmpl-plain', object: 'chat.completion' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )

      const response = await chat(key.secret, streamBody())

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(await response.text()).toBe(JSON.stringify({ id: 'chatcmpl-plain', object: 'chat.completion' }))
    })
  })

  describe('streaming deadlines', () => {
    test('a slow first byte aborts the stream after the header deadline', async () => {
      upstream.respondWith((call) => {
        const held = controlledSse(call)
        return new Response(held.stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      })
      const baseline = upstream.calls.length

      const response = await chat(key.secret, streamBody())
      expect(response.status).toBe(200)

      const reading = readAll(response.body)
      timer.advance(1_001)
      timer.flush()

      expect(await reading).toBe('')
      expect(upstream.calls[baseline]?.signal?.aborted).toBe(true)
      expect(upstream.calls.length - baseline).toBe(1)
    })

    test('an idle gap between chunks ends the stream after the idle deadline', async () => {
      upstream.respondWith((call) => {
        const held = controlledSse(call)
        held.enqueue(sseEvent(HELLO_CHUNK))
        return new Response(held.stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      })
      const baseline = upstream.calls.length

      const response = await chat(key.secret, streamBody())
      expect(response.status).toBe(200)

      const reading = readAll(response.body)
      timer.advance(2_001)
      timer.flush()

      expect(await reading).toBe(sseEvent(HELLO_CHUNK))
      expect(upstream.calls[baseline]?.signal?.aborted).toBe(true)
    })

    test('the streaming watchdog never aborts a buffered request', async () => {
      upstream.respondWith(() => new Promise<Response>(() => {}))
      const baseline = upstream.calls.length

      void chat(key.secret, completionBody())
      await until(() => upstream.calls.length > baseline)
      timer.advance(100_000)
      timer.flush()

      expect(upstream.calls[baseline]?.signal?.aborted).toBe(false)
    })
  })

  describe('malformed or interrupted terminations', () => {
    test('a stream that ends abruptly is delivered exactly as the upstream ended it', async () => {
      const truncated = sseEvent(HELLO_CHUNK).slice(0, -1)
      upstream.respondWith((call) => {
        const held = controlledSse(call)
        held.enqueue(sseEvent(FIRST_CHUNK))
        held.enqueue(truncated)
        held.close()
        return new Response(held.stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      })
      const baseline = upstream.calls.length

      const response = await chat(key.secret, streamBody())

      expect(response.status).toBe(200)
      expect(await response.text()).toBe(`${sseEvent(FIRST_CHUNK)}${truncated}`)
      expect(upstream.calls.length - baseline).toBe(1)
    })

    test('a mid-stream upstream failure ends the stream without an error body', async () => {
      let held: ReturnType<typeof controlledSse> | undefined
      upstream.respondWith((call) => {
        held = controlledSse(call)
        held.enqueue(sseEvent(HELLO_CHUNK))
        return new Response(held.stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      })
      const baseline = upstream.calls.length

      const response = await chat(key.secret, streamBody())
      expect(response.status).toBe(200)

      const reading = readAll(response.body)
      await Bun.sleep(0)
      held!.error(new Error('upstream died mid-stream'))

      expect(await reading).toBe(sseEvent(HELLO_CHUNK))
      expect(upstream.calls.length - baseline).toBe(1)
    })
  })

  describe('cancellation', () => {
    test('a downstream disconnect aborts the upstream stream immediately', async () => {
      let held: ReturnType<typeof controlledSse>
      upstream.respondWith((call) => {
        held = controlledSse(call)
        held.enqueue(sseEvent(HELLO_CHUNK))
        return new Response(held.stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      })
      const baseline = upstream.calls.length
      const controller = new AbortController()

      const response = await chat(key.secret, streamBody(), {}, controller.signal)
      expect(response.status).toBe(200)

      const reading = readAll(response.body)
      await Bun.sleep(0)
      expect(upstream.calls[baseline]?.signal?.aborted).toBe(false)

      controller.abort()

      expect(upstream.calls[baseline]?.signal?.aborted).toBe(true)
      expect(await reading).toBe(sseEvent(HELLO_CHUNK))
    })
  })

  describe('pre-stream upstream failures', () => {
    test('a 5xx before streaming keeps the OpenAI-shaped error contract', async () => {
      upstream.respondWith(() => new Response('upstream body', { status: 503 }))
      const baseline = upstream.calls.length

      const response = await chat(key.secret, streamBody())

      expect(response.status).toBe(503)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(response.headers.get('x-request-id')).toMatch(/^req_/)
      const failure = (await response.json()) as { error: { code: string; type: string } }
      expect(failure.error.code).toBe('upstream_unavailable')
      expect(failure.error.type).toBe('api_error')
      expect(upstream.calls.length - baseline).toBe(2)
    })

    test('a 400 before streaming maps to the stable upstream code', async () => {
      upstream.respondWith(() => new Response('bad request', { status: 400 }))
      const baseline = upstream.calls.length

      const response = await chat(key.secret, streamBody())

      expect(response.status).toBe(400)
      const failure = (await response.json()) as { error: { code: string } }
      expect(failure.error.code).toBe('upstream_bad_request')
      expect(upstream.calls.length - baseline).toBe(1)
    })
  })
})

test('the mock records a streamed SSE request exactly as sent', async () => {
  const upstream = mockUpstreamTransport()
  const call: RecordedUpstreamCall = await new Promise((resolve) => {
    upstream.respondWith((seen) => {
      resolve(seen)
      return new Response('data: {}\n\n', { status: 200 })
    })
    upstream.fetch('https://upstream.example/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true }),
    })
  })

  expect(call.body).toBe(JSON.stringify({ stream: true }))
  expect(call.headers.authorization).toBe('Bearer sk-test')
})

async function readAll(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (body === null) return ''
  const reader = body.getReader()
  const chunks: string[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(new TextDecoder().decode(value))
  }
  return chunks.join('')
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not reached')
    await Bun.sleep(5)
  }
}
