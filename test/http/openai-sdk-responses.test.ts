import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import OpenAI from 'openai'
import { appFetch, completeSetup, createTestApp, type TestApp } from '../support/app.ts'
import { mockUpstreamTransport, sseEvent, sseResponse } from '../support/inference.ts'

const UPSTREAM_KEY = 'sk-upstream-secret-value-for-tests'
const BASE_URL = 'https://api.example.com/v1'
const MODEL = 'gpt-4o-mini'

describe('the official OpenAI SDK through the Responses surface', () => {
  let iroha: TestApp
  let csrf: string
  let client: OpenAI
  let upstream: ReturnType<typeof mockUpstreamTransport>

  beforeEach(async () => {
    upstream = mockUpstreamTransport()
    iroha = await createTestApp({ upstreamTransport: upstream.fetch })
    csrf = (await completeSetup(iroha)).csrf
    const connectionId = await createConnection(iroha, csrf)
    const secret = await createGatewayKey(iroha, csrf, connectionId)
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

  test('creates stored and non-stored responses with tools and structured output', async () => {
    upstream.respondWith((call) => {
      const request = JSON.parse(call.body ?? '{}') as { model?: string; store?: boolean }
      return Response.json(responseBody(request.model ?? MODEL, request.store ?? true))
    })

    const stored = await client.responses.create({
      model: MODEL,
      input: 'Call a tool',
      store: true,
      tools: [
        {
          type: 'function',
          name: 'weather',
          description: 'Weather',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          strict: true,
        },
      ],
    })
    const transient = await client.responses.create({
      model: MODEL,
      input: 'Return JSON',
      store: false,
      text: {
        format: {
          type: 'json_schema',
          name: 'answer',
          strict: true,
          schema: { type: 'object', properties: { answer: { type: 'string' } } },
        },
      },
    })

    expect(stored.id).toBe('resp_mock')
    expect(transient.output_text).toBe('Hello')
    const first = JSON.parse(upstream.calls[0]?.body ?? '{}') as { store: boolean; tools: unknown[] }
    const second = JSON.parse(upstream.calls[1]?.body ?? '{}') as { store: boolean; text: unknown }
    expect(first.store).toBe(true)
    expect(first.tools).toHaveLength(1)
    expect(second.store).toBe(false)
    expect(second.text).toBeDefined()
  })

  test('iterates Responses stream events in provider order', async () => {
    const completed = responseBody(MODEL, false)
    upstream.respondWith(() =>
      sseResponse([
        sseEvent(JSON.stringify({ type: 'response.created', response: completed, sequence_number: 0 })),
        sseEvent(
          JSON.stringify({
            type: 'response.output_text.delta',
            item_id: 'msg_mock',
            output_index: 0,
            content_index: 0,
            delta: 'Hello',
            logprobs: [],
            sequence_number: 1,
          }),
        ),
        sseEvent(JSON.stringify({ type: 'response.completed', response: completed, sequence_number: 2 })),
      ]),
    )

    const stream = await client.responses.create({ model: MODEL, input: 'Hello', stream: true })
    const eventTypes: string[] = []
    for await (const event of stream) eventTypes.push(event.type)

    expect(eventTypes).toEqual([
      'response.created',
      'response.output_text.delta',
      'response.completed',
    ])
  })

  test('surfaces malformed stream events instead of inventing replacements', async () => {
    upstream.respondWith(() => sseResponse([sseEvent('{not valid json')]))
    const stream = await client.responses.create({ model: MODEL, input: 'Hello', stream: true })

    const result = await (async () => {
      for await (const _event of stream) return 'read'
      return 'ended'
    })().then(
      (value) => value,
      () => 'rejected',
    )

    expect(result).toBe('rejected')
    expect(upstream.calls).toHaveLength(1)
  })

  test('SDK cancellation aborts the upstream Responses request', async () => {
    upstream.respondWith(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          })
        }),
    )
    const controller = new AbortController()
    const pending = client.responses.create(
      { model: MODEL, input: 'Hello' },
      { signal: controller.signal },
    )
    pending.catch(() => {})
    for (let index = 0; index < 100 && upstream.calls.length === 0; index++) await Promise.resolve()
    expect(upstream.calls).toHaveLength(1)

    controller.abort()

    await pending.then(() => 'closed', () => 'aborted')
    expect(upstream.calls[0]?.signal?.aborted).toBe(true)
  })
})

function responseBody(model: string, store: boolean) {
  return {
    id: 'resp_mock',
    object: 'response',
    created_at: 1_700_000_000,
    status: 'completed',
    background: false,
    billing: { payer: 'developer' },
    completed_at: 1_700_000_001,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    max_tool_calls: null,
    model,
    output: [
      {
        id: 'msg_mock',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello', annotations: [], logprobs: [] }],
      },
    ],
    parallel_tool_calls: true,
    previous_response_id: null,
    prompt_cache_key: null,
    prompt_cache_retention: null,
    reasoning: { effort: null, summary: null },
    safety_identifier: null,
    service_tier: 'default',
    store,
    temperature: 1,
    text: { format: { type: 'text' }, verbosity: 'medium' },
    tool_choice: 'auto',
    tools: [],
    top_logprobs: 0,
    top_p: 1,
    truncation: 'disabled',
    usage: {
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 2,
    },
    user: null,
    metadata: {},
  }
}

async function createConnection(iroha: TestApp, csrf: string): Promise<string> {
  const response = await iroha.fetch('/api/v1/admin/provider-connections', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: 'SDK Responses', baseUrl: BASE_URL, upstreamKey: UPSTREAM_KEY }),
    csrf,
  })
  if (response.status !== 201) throw new Error(`Connection create failed: ${await response.text()}`)
  return ((await response.json()) as { id: string }).id
}

async function createGatewayKey(iroha: TestApp, csrf: string, connectionId: string): Promise<string> {
  const response = await iroha.fetch('/api/v1/admin/gateway-keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'SDK Responses client', scope: [{ connectionId }] }),
    csrf,
  })
  if (response.status !== 201) throw new Error(`Gateway Key create failed: ${await response.text()}`)
  return ((await response.json()) as { secret: string }).secret
}
