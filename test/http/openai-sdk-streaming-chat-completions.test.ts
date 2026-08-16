import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import OpenAI from 'openai'
import {
  appFetch,
  completeSetup,
  createTestApp,
  type TestApp,
} from '../support/app.ts'
import {
  controlledSse,
  mockUpstreamTransport,
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
  displayName: string
  keys: { id: string; health: string }[]
}

const STREAM = {
  id: 'chatcmpl-sdk-stream',
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

/**
 * The official OpenAI JavaScript SDK consuming a stream through Iroha's
 * assembled HTTP boundary, with a mocked upstream emitting SSE bytes.
 */
describe('the official OpenAI SDK streaming through the Chat Completions surface', () => {
  let iroha: TestApp
  let csrf: string
  let client: OpenAI
  let providerId: string
  let providerHandle: string
  let upstream: ReturnType<typeof mockUpstreamTransport>
  let timer: FakeTimer

  beforeEach(async () => {
    upstream = mockUpstreamTransport()
    timer = fakeTimer()
    iroha = await createTestApp({
      upstreamTransport: upstream.fetch,
      timer,
      streamingTimeouts: { streamingHeaderMs: 1_000, streamingIdleMs: 2_000 },
    })
    csrf = (await completeSetup(iroha)).csrf
    providerId = await createConnection()
    providerHandle = (await iroha.database.providers.getProvider(providerId))!.handle
    const secret = await createGatewayKey([{ providerId }])
    client = new OpenAI({
      apiKey: secret,
      baseURL: `http://iroha.test/providers/${providerHandle}/v1`,
      fetch: appFetch(iroha.app),
      // UI tests register a DOM in the same process, which makes the SDK's
      // browser guard fire; this is test-only and never carries real secrets.
      dangerouslyAllowBrowser: true,
    })
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  test('streams tokens through the official SDK in order', async () => {
    const blocks = [
      sseEvent(chunk({ role: 'assistant', content: '' }, null)),
      sseEvent(chunk({ content: 'Hello' }, null)),
      sseEvent(chunk({ content: ' world' }, null)),
      sseEvent(chunk({}, 'stop')),
      sseDone(),
    ]
    upstream.respondWith(() => sseResponse(blocks))
    const baseline = upstream.calls.length

    const stream = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: 'Say hello' }],
      stream: true,
    })

    const text: string[] = []
    const finishReasons: (string | null)[] = []
    for await (const part of stream) {
      const content = part.choices[0]?.delta.content ?? ''
      if (content !== '') text.push(content)
      finishReasons.push(part.choices[0]?.finish_reason ?? null)
    }

    expect(text.join('')).toBe('Hello world')
    expect(finishReasons).toContain('stop')

    expect(upstream.calls.length - baseline).toBe(1)
    const forwarded = upstream.calls[baseline]!
    expect(forwarded.url).toBe(`${BASE_URL}/chat/completions`)
    expect(forwarded.headers.authorization).toBe(`Bearer ${UPSTREAM_KEY}`)
    const sent = JSON.parse(forwarded.body ?? '{}') as { model: string; stream: boolean }
    expect(sent.model).toBe(MODEL)
    expect(sent.stream).toBe(true)
  })

  test('cancellation through the SDK aborts the upstream stream', async () => {
    let held: ReturnType<typeof controlledSse>
    upstream.respondWith((call) => {
      held = controlledSse(call)
      held.enqueue(sseEvent(chunk({ content: 'Hello' }, null)))
      return new Response(held.stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const baseline = upstream.calls.length
    const controller = new AbortController()

    const stream = await client.chat.completions.create(
      { model: MODEL, messages: [{ role: 'user', content: 'hello' }], stream: true },
      { signal: controller.signal },
    )
    const iterator = stream[Symbol.asyncIterator]()

    const first = await iterator.next().then(
      (step) => step.value,
      () => null,
    )
    const firstContent =
      first === null ? null : (first as { choices?: { delta?: { content?: string } }[] })
    expect(firstContent?.choices?.[0]?.delta?.content).toBe('Hello')
    expect(upstream.calls[baseline]?.signal?.aborted).toBe(false)

    controller.abort()

    // Whatever the SDK surfaces (an abort error or a clean end), the upstream
    // work must have been torn down and only the emitted bytes may have flowed.
    await iterator.next().then(() => 'closed', () => 'aborted')
    expect(upstream.calls[baseline]?.signal?.aborted).toBe(true)
  })

  const createConnection = async (): Promise<string> => {
    const response = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle: crypto.randomUUID(),
        displayName: 'SDK streaming example',
        baseUrl: BASE_URL,
        keys: [{ upstreamKey: UPSTREAM_KEY }],
      }),
      csrf,
    })
    if (response.status !== 201) {
      throw new Error(`Connection create failed with ${response.status}: ${await response.text()}`)
    }
    const connection = (await response.json()) as ConnectionBody
    return connection.id
  }

  const createGatewayKey = async (scope: unknown[]): Promise<string> => {
    const response = await iroha.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'SDK stream client', scope }),
      csrf,
    })
    if (response.status !== 201) {
      throw new Error(`Key create failed with ${response.status}: ${await response.text()}`)
    }
    const key = (await response.json()) as { secret: string }
    return key.secret
  }
})