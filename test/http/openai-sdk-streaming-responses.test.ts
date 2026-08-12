import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import OpenAI from 'openai'
import {
  appFetch,
  completeSetup,
  createTestApp,
  type TestApp,
} from '../support/app.ts'
import { controlledSse, mockUpstreamTransport, sseDone, sseEvent } from '../support/inference.ts'

const UPSTREAM_KEY = 'sk-upstream-secret-value-for-tests'
const BASE_URL = 'https://api.example.com/v1'
const MODEL = 'gpt-4o-mini'

/**
 * The official OpenAI JavaScript SDK consuming a Responses stream through
 * Iroha's assembled HTTP boundary. The mocked upstream emits SSE bytes
 * shaped like the public OpenAI Responses API.
 */
describe('the official OpenAI SDK streaming through the Responses surface', () => {
  let iroha: TestApp
  let csrf: string
  let client: OpenAI
  let connectionId: string
  let upstream: ReturnType<typeof mockUpstreamTransport>

  beforeEach(async () => {
    upstream = mockUpstreamTransport()
    iroha = await createTestApp({ upstreamTransport: upstream.fetch })
    csrf = (await completeSetup(iroha)).csrf
    connectionId = await createConnection()
    const secret = await createGatewayKey([{ connectionId }])
    client = new OpenAI({
      apiKey: secret,
      baseURL: `http://iroha.test/providers/${connectionId}/v1`,
      fetch: appFetch(iroha.app),
      maxRetries: 0,
      dangerouslyAllowBrowser: true,
    })
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  test('client.responses.stream() yields events in provider order', async () => {
    const created = {
      id: 'resp_sdk_stream',
      object: 'response',
      created_at: 1_700_000_000,
      status: 'in_progress',
      model: MODEL,
    }
    const completed = { ...created, status: 'completed', output: [] }

    upstream.respondWith(() =>
      new Response(
        [
          sseEvent(JSON.stringify({ type: 'response.created', response: created, sequence_number: 0 })),
          sseEvent(
            JSON.stringify({
              type: 'response.output_text.delta',
              item_id: 'msg_sdk',
              output_index: 0,
              content_index: 0,
              delta: 'Hello',
              logprobs: [],
              sequence_number: 1,
            }),
          ),
          sseEvent(
            JSON.stringify({
              type: 'response.output_text.delta',
              item_id: 'msg_sdk',
              output_index: 0,
              content_index: 0,
              delta: ' SDK',
              logprobs: [],
              sequence_number: 2,
            }),
          ),
          sseEvent(JSON.stringify({ type: 'response.completed', response: completed, sequence_number: 3 })),
          sseDone(),
        ].join(''),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    )
    const baseline = upstream.calls.length

    const stream = await client.responses.create({
      model: MODEL,
      input: 'Hello',
      stream: true,
    })

    const eventTypes: string[] = []
    const text: string[] = []
    for await (const event of stream) {
      eventTypes.push(event.type)
      if (event.type === 'response.output_text.delta') {
        text.push((event as { delta: string }).delta)
      }
    }

    expect(eventTypes).toEqual([
      'response.created',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.completed',
    ])
    expect(text.join('')).toBe('Hello SDK')

    const forwarded = upstream.calls[baseline]!
    expect(forwarded.url).toBe(`${BASE_URL}/responses`)
    expect(forwarded.headers.authorization).toBe(`Bearer ${UPSTREAM_KEY}`)
    const sent = JSON.parse(forwarded.body ?? '{}') as { model: string; stream: boolean }
    expect(sent.model).toBe(MODEL)
    expect(sent.stream).toBe(true)
  })

  test('cancellation through the SDK aborts the upstream Responses stream', async () => {
    let held: ReturnType<typeof controlledSse>
    upstream.respondWith((call) => {
      held = controlledSse(call)
      held.enqueue(
        sseEvent(
          JSON.stringify({
            type: 'response.created',
            response: { id: 'resp_pending', object: 'response', status: 'in_progress' },
            sequence_number: 0,
          }),
        ),
      )
      return new Response(held.stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const baseline = upstream.calls.length
    const controller = new AbortController()

    const stream = await client.responses.create(
      { model: MODEL, input: 'Hello', stream: true },
      { signal: controller.signal },
    )
    const iterator = stream[Symbol.asyncIterator]()

    const first = await iterator.next().then(
      (step) => step.value,
      () => null,
    )
    expect(first).not.toBeNull()
    expect(upstream.calls[baseline]?.signal?.aborted).toBe(false)

    controller.abort()

    await iterator.next().then(() => 'closed', () => 'aborted')
    expect(upstream.calls[baseline]?.signal?.aborted).toBe(true)
  })

  const createConnection = async (): Promise<string> => {
    const response = await iroha.fetch('/api/v1/admin/provider-connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'SDK Responses stream example',
        baseUrl: BASE_URL,
        upstreamKey: UPSTREAM_KEY,
      }),
      csrf,
    })
    if (response.status !== 201) {
      throw new Error(`Connection create failed with ${response.status}: ${await response.text()}`)
    }
    return ((await response.json()) as { id: string }).id
  }

  const createGatewayKey = async (scope: unknown[]): Promise<string> => {
    const response = await iroha.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'SDK Responses stream client', scope }),
      csrf,
    })
    if (response.status !== 201) {
      throw new Error(`Key create failed with ${response.status}: ${await response.text()}`)
    }
    return ((await response.json()) as { secret: string }).secret
  }
})
