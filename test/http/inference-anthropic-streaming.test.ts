import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  completeSetup,
  createTestApp,
  type TestApp,
} from '../support/app.ts'
import {
  controlledSse,
  mockUpstreamTransport,
  sseResponse,
  type UpstreamResponder,
} from '../support/inference.ts'

const UPSTREAM_KEY = 'sk-ant-api03-anthropic-upstream-key-for-tests-only-0123456789'
const MODEL = 'anthropic-opus-5'
const BASE_URL = 'https://api.anthropic.com/v1'

interface ConnectionBody {
  id: string
  handle: string
  displayName: string
  templateId: string | null
}

/**
 * The OpenAI-shape Chat Completions body the test sends to
 * `/providers/{handle}/v1/chat/completions`. The streaming translate path is the
 * same code path; only `stream: true` flips the adapter into the streaming
 * translator.
 */
function openAiBody(model: string = MODEL): Record<string, unknown> {
  return {
    model,
    messages: [{ role: 'user', content: 'Say hello' }],
    stream: true,
  }
}

/**
 * One Anthropic SSE event block, exactly as the upstream emits it. Anthropic
 * uses named events with `event:` and `data:` lines separated by a blank
 * line — `docs/research/anthropic-api.md` section D.
 */
function anthropicEvent(name: string, payload: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`
}

const TEXT_BLOCK_START = {
  type: 'content_block_start',
  index: 0,
  content_block: { type: 'text', text: '' },
}

function textDelta(index: number, text: string): Record<string, unknown> {
  return {
    type: 'content_block_delta',
    index,
    delta: { type: 'text_delta', text },
  }
}

function toolUseStart(index: number, id: string, name: string): Record<string, unknown> {
  return {
    type: 'content_block_start',
    index,
    content_block: { type: 'tool_use', id, name, input: {} },
  }
}

function inputJsonDelta(index: number, partialJson: string): Record<string, unknown> {
  return {
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: partialJson },
  }
}

function messageStart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const messageOverrides = (overrides.message ?? {}) as Record<string, unknown>
  const outerOverrides = (overrides.outer ?? {}) as Record<string, unknown>
  return {
    type: 'message_start',
    message: {
      id: 'msg_01HelloFromAnthropic',
      type: 'message',
      role: 'assistant',
      content: [],
      model: MODEL,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 12,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      ...messageOverrides,
    },
    ...outerOverrides,
  }
}

function messageDelta(
  stopReason: string | null,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'message_delta',
    delta: {
      stop_reason: stopReason,
      stop_sequence: null,
    },
    usage: {
      output_tokens: 5,
      input_tokens: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    },
    ...overrides,
  }
}

const MESSAGE_STOP = { type: 'message_stop' }
const PING = { type: 'ping' }

interface OpenAiChunk {
  id: string
  object: string
  model: string
  choices: Array<{
    index: number
    delta: Record<string, unknown>
    finish_reason: string | null
  }>
  usage?: Record<string, unknown>
}

/**
 * Builds the upstream's Anthropic-shaped SSE stream from a list of event
 * payloads. The list is emitted in declared order; the helper wraps each
 * payload with the named `event:` line so the adapter's SSE parser sees the
 * same wire format Anthropic actually publishes.
 */
function anthropicSse(events: Array<{ name: string; payload: Record<string, unknown> }>): string {
  return events.map((e) => anthropicEvent(e.name, e.payload)).join('')
}

const TEXT_ONLY_EVENTS = [
  { name: 'message_start', payload: messageStart() },
  { name: 'content_block_start', payload: TEXT_BLOCK_START },
  { name: 'content_block_delta', payload: textDelta(0, 'Hello') },
  { name: 'content_block_delta', payload: textDelta(0, ' world') },
  { name: 'content_block_stop', payload: { type: 'content_block_stop', index: 0 } },
  { name: 'message_delta', payload: messageDelta('end_turn') },
  { name: 'message_stop', payload: MESSAGE_STOP },
]

describe('Anthropic Inference Adapter — streaming Chat Completions', () => {
  let iroha: TestApp
  let csrf: string
  let upstream: ReturnType<typeof mockUpstreamTransport>
  let connection: ConnectionBody
  let path: string

  beforeEach(async () => {
    upstream = mockUpstreamTransport()
    iroha = await createTestApp({ upstreamTransport: upstream.fetch })
    csrf = (await completeSetup(iroha)).csrf
    connection = await createAnthropicConnection()
    path = `/providers/${connection.handle}/v1/chat/completions`
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  const createAnthropicConnection = async (): Promise<ConnectionBody> => {
    const response = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Anthropic',
        handle: 'anthropic-streaming',
        baseUrl: BASE_URL,
        templateId: 'anthropic',
        keys: [{ upstreamKey: UPSTREAM_KEY }],
      }),
      csrf,
    })
    if (response.status !== 201) {
      throw new Error(`Connection create failed with ${response.status}: ${await response.text()}`)
    }
    return (await response.json()) as ConnectionBody
  }

  const createKey = async (scope: unknown[]): Promise<{ secret: string }> => {
    const response = await iroha.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'App credential', scope }),
      csrf,
    })
    if (response.status !== 201) {
      throw new Error(`Key create failed with ${response.status}: ${await response.text()}`)
    }
    return (await response.json()) as { secret: string }
  }

  const chat = (
    token: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) =>
    iroha.fetch(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...headers,
      },
      body: JSON.stringify(body),
    })

  test('the upstream request sets stream: true on the Anthropic body', async () => {
    upstream.respondWith(() => sseResponse([anthropicSse(TEXT_ONLY_EVENTS)]))
    const { secret } = await createKey([{ providerId: connection.id }])

    await chat(secret, openAiBody())

    expect(upstream.calls).toHaveLength(1)
    const sent = JSON.parse(upstream.calls[0]!.body ?? '{}') as { stream?: boolean }
    expect(sent.stream).toBe(true)
  })

  test('text-only stream emits OpenAI chat.completion.chunk events in order and ends with [DONE]', async () => {
    upstream.respondWith(() => sseResponse([anthropicSse(TEXT_ONLY_EVENTS)]))
    const { secret } = await createKey([{ providerId: connection.id }])

    const response = await chat(secret, openAiBody())
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const events = parseSse(await response.text())
    const data = events.filter((e) => !e.isDone)
    const done = events.filter((e) => e.isDone)
    expect(done).toHaveLength(1)

    const chunks = data.map((e) => e.payload as OpenAiChunk)
    // First chunk: role announcement, no content yet.
    const first = chunks[0]!
    expect(first.id).toBe('msg_01HelloFromAnthropic')
    expect(first.object).toBe('chat.completion.chunk')
    expect(first.model).toBe(MODEL)
    expect(first.choices).toHaveLength(1)
    expect(first.choices[0]!.index).toBe(0)
    expect(first.choices[0]!.delta.role).toBe('assistant')
    expect(first.choices[0]!.finish_reason).toBeNull()

    // Two text deltas combined into "Hello world".
    const textChunks = chunks.filter((c) => typeof c.choices[0]?.delta.content === 'string')
    expect(textChunks.map((c) => c.choices[0]!.delta.content)).toEqual(['Hello', ' world'])

    // The penultimate chunk (after message_delta) carries finish_reason + usage.
    const final = chunks[chunks.length - 1]!
    expect(final.choices[0]!.finish_reason).toBe('stop')
    expect(final.usage).toBeDefined()

    // Every chunk carries the same id/model so the OpenAI SDK can correlate.
    for (const chunk of chunks) {
      expect(chunk.id).toBe('msg_01HelloFromAnthropic')
      expect(chunk.model).toBe(MODEL)
      expect(chunk.object).toBe('chat.completion.chunk')
    }
  })

  test('usage merges message_start and message_delta and is emitted exactly once', async () => {
    upstream.respondWith(() =>
      sseResponse([
        anthropicSse([
          { name: 'message_start', payload: messageStart({
            message: {
              id: 'msg_usage',
              usage: {
                input_tokens: 100,
                output_tokens: 1,
                cache_creation_input_tokens: 30,
                cache_read_input_tokens: 20,
              },
            },
          }) },
          { name: 'content_block_start', payload: TEXT_BLOCK_START },
          { name: 'content_block_delta', payload: textDelta(0, 'OK') },
          { name: 'content_block_stop', payload: { type: 'content_block_stop', index: 0 } },
          {
            name: 'message_delta',
            payload: {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: {
                output_tokens: 50,
                input_tokens: null,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
                output_tokens_details: { thinking_tokens: 12 },
              },
            },
          },
          { name: 'message_stop', payload: MESSAGE_STOP },
        ]),
      ]),
    )
    const { secret } = await createKey([{ providerId: connection.id }])

    const response = await chat(secret, openAiBody())
    const events = parseSse(await response.text())
    const chunks = events.filter((e) => !e.isDone).map((e) => e.payload as OpenAiChunk)

    // Only the final chunk carries a usage field.
    const usageChunks = chunks.filter((c) => c.usage !== undefined)
    expect(usageChunks).toHaveLength(1)
    const usage = usageChunks[0]!.usage!
    expect(usage.prompt_tokens).toBe(100)
    expect(usage.completion_tokens).toBe(50)
    expect(usage.total_tokens).toBe(200)
    expect(usage.cache_creation_input_tokens).toBe(30)
    expect(usage.cache_read_input_tokens).toBe(20)
    expect((usage.prompt_tokens_details as { cached_tokens: number }).cached_tokens).toBe(50)
    expect((usage.completion_tokens_details as { reasoning_tokens: number }).reasoning_tokens).toBe(12)

    // The final chunk also carries finish_reason.
    expect(usageChunks[0]!.choices[0]!.finish_reason).toBe('stop')
  })

  test('tool-call stream emits tool_calls deltas with id, name, and accumulated arguments', async () => {
    const events = [
      { name: 'message_start', payload: messageStart() },
      { name: 'content_block_start', payload: toolUseStart(0, 'toolu_01ABC', 'get_weather') },
      { name: 'content_block_delta', payload: inputJsonDelta(0, '{"city":') },
      { name: 'content_block_delta', payload: inputJsonDelta(0, '"Paris"}') },
      { name: 'content_block_stop', payload: { type: 'content_block_stop', index: 0 } },
      { name: 'message_delta', payload: messageDelta('tool_use') },
      { name: 'message_stop', payload: MESSAGE_STOP },
    ]
    upstream.respondWith(() => sseResponse([anthropicSse(events)]))
    const { secret } = await createKey([{ providerId: connection.id }])

    const response = await chat(secret, openAiBody())
    const chunks = parseSse(await response.text())
      .filter((e) => !e.isDone)
      .map((e) => e.payload as OpenAiChunk)

    // The first tool chunk emits the id, type, and name; arguments start empty.
    const toolStarts = chunks.filter((c) => c.choices[0]?.delta.tool_calls !== undefined)
    expect(toolStarts.length).toBeGreaterThanOrEqual(1)
    const firstTool = toolStarts[0]!.choices[0]!.delta.tool_calls as Array<{
      id: string
      type: string
      index: number
      function: { name: string; arguments: string }
    }>
    expect(firstTool[0]!.id).toBe('toolu_01ABC')
    expect(firstTool[0]!.type).toBe('function')
    expect(firstTool[0]!.index).toBe(0)
    expect(firstTool[0]!.function.name).toBe('get_weather')
    expect(firstTool[0]!.function.arguments).toBe('')

    // The subsequent input_json_delta chunks carry only the partial JSON.
    // The OpenAI SDK concatenates them to reconstruct the full argument
    // string; the adapter never does that on the wire.
    const argDeltas = toolStarts.slice(1).map(
      (tool) => (tool.choices[0]!.delta.tool_calls as Array<{
        function: { arguments: string }
        index: number
      }>)[0]!,
    )
    expect(argDeltas.length).toBe(2)
    expect(argDeltas[0]!.index).toBe(0)
    expect(argDeltas[0]!.function.arguments).toBe('{"city":')
    expect(argDeltas[1]!.index).toBe(0)
    expect(argDeltas[1]!.function.arguments).toBe('"Paris"}')
    const concatenated = argDeltas.map((d) => d.function.arguments).join('')
    expect(concatenated).toBe('{"city":"Paris"}')

    // The final chunk carries finish_reason="tool_calls".
    const final = chunks[chunks.length - 1]!
    expect(final.choices[0]!.finish_reason).toBe('tool_calls')
  })

  test('multi-block stream emits two text deltas in order', async () => {
    const events = [
      { name: 'message_start', payload: messageStart() },
      { name: 'content_block_start', payload: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { name: 'content_block_delta', payload: textDelta(0, 'First') },
      { name: 'content_block_stop', payload: { type: 'content_block_stop', index: 0 } },
      { name: 'content_block_start', payload: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
      { name: 'content_block_delta', payload: textDelta(1, ' second') },
      { name: 'content_block_stop', payload: { type: 'content_block_stop', index: 1 } },
      { name: 'message_delta', payload: messageDelta('end_turn') },
      { name: 'message_stop', payload: MESSAGE_STOP },
    ]
    upstream.respondWith(() => sseResponse([anthropicSse(events)]))
    const { secret } = await createKey([{ providerId: connection.id }])

    const response = await chat(secret, openAiBody())
    const chunks = parseSse(await response.text())
      .filter((e) => !e.isDone)
      .map((e) => e.payload as OpenAiChunk)
    const textChunks = chunks.filter((c) => typeof c.choices[0]?.delta.content === 'string')
    expect(textChunks.map((c) => c.choices[0]!.delta.content)).toEqual(['First', ' second'])
  })

  test('refusal stop_reason maps to OpenAI finish_reason content_filter', async () => {
    const events = [
      { name: 'message_start', payload: messageStart() },
      { name: 'content_block_start', payload: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'I cannot help with that.' } } },
      { name: 'content_block_stop', payload: { type: 'content_block_stop', index: 0 } },
      { name: 'message_delta', payload: messageDelta('refusal') },
      { name: 'message_stop', payload: MESSAGE_STOP },
    ]
    upstream.respondWith(() => sseResponse([anthropicSse(events)]))
    const { secret } = await createKey([{ providerId: connection.id }])

    const response = await chat(secret, openAiBody())
    const parsedEvents = parseSse(await response.text())
    const lastChunk = parsedEvents
      .filter((e) => !e.isDone)
      .map((e) => e.payload as OpenAiChunk)
      .at(-1)
    expect(lastChunk!.choices[0]!.finish_reason).toBe('content_filter')
  })

  test('compaction stop_reason maps to OpenAI finish_reason length (LiteLLM convention)', async () => {
    const events = [
      { name: 'message_start', payload: messageStart() },
      { name: 'content_block_start', payload: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'compacted' } } },
      { name: 'content_block_stop', payload: { type: 'content_block_stop', index: 0 } },
      { name: 'message_delta', payload: messageDelta('compaction') },
      { name: 'message_stop', payload: MESSAGE_STOP },
    ]
    upstream.respondWith(() => sseResponse([anthropicSse(events)]))
    const { secret } = await createKey([{ providerId: connection.id }])

    const response = await chat(secret, openAiBody())
    const parsedEvents = parseSse(await response.text())
    const lastChunk = parsedEvents
      .filter((e) => !e.isDone)
      .map((e) => e.payload as OpenAiChunk)
      .at(-1)
    expect(lastChunk!.choices[0]!.finish_reason).toBe('length')
  })

  test('ping events are dropped; no extra chunks are emitted', async () => {
    const events = [
      { name: 'message_start', payload: messageStart() },
      { name: 'ping', payload: PING },
      { name: 'content_block_start', payload: TEXT_BLOCK_START },
      { name: 'content_block_delta', payload: textDelta(0, 'hello') },
      { name: 'ping', payload: PING },
      { name: 'content_block_stop', payload: { type: 'content_block_stop', index: 0 } },
      { name: 'message_delta', payload: messageDelta('end_turn') },
      { name: 'message_stop', payload: MESSAGE_STOP },
    ]
    upstream.respondWith(() => sseResponse([anthropicSse(events)]))
    const { secret } = await createKey([{ providerId: connection.id }])

    const response = await chat(secret, openAiBody())
    const parsedEvents = parseSse(await response.text())
    const chunks = parsedEvents.filter((e) => !e.isDone).map((e) => e.payload as OpenAiChunk)
    // role + 1 text delta + final = 3 chunks; pings and content_block_stop contribute nothing.
    expect(chunks).toHaveLength(3)
    // Final chunk still carries finish_reason and usage.
    expect(chunks.at(-1)!.choices[0]!.finish_reason).toBe('stop')
    expect(chunks.at(-1)!.usage).toBeDefined()
  })

  test('Anthropic error event becomes a final chunk with finish_reason = error.type, then [DONE]', async () => {
    const events = [
      { name: 'message_start', payload: messageStart() },
      { name: 'content_block_start', payload: TEXT_BLOCK_START },
      { name: 'content_block_delta', payload: textDelta(0, 'Half') },
      {
        name: 'error',
        payload: {
          type: 'error',
          error: { type: 'overloaded_error', message: 'Overloaded' },
        },
      },
    ]
    upstream.respondWith(() => sseResponse([anthropicSse(events)]))
    const { secret } = await createKey([{ providerId: connection.id }])

    const response = await chat(secret, openAiBody())
    const parsedEvents = parseSse(await response.text())
    const chunks = parsedEvents.filter((e) => !e.isDone).map((e) => e.payload as OpenAiChunk)
    const done = parsedEvents.filter((e) => e.isDone)

    expect(chunks.length).toBeGreaterThanOrEqual(3)
    const final = chunks[chunks.length - 1]!
    expect(final.choices[0]!.finish_reason).toBe('overloaded_error')
    expect(done).toHaveLength(1)
  })

  test('streaming reaches the upstream with the configured x-api-key and anthropic-version', async () => {
    upstream.respondWith(() => sseResponse([anthropicSse(TEXT_ONLY_EVENTS)]))
    const { secret } = await createKey([{ providerId: connection.id }])

    await chat(secret, openAiBody())

    const call = upstream.calls[0]!
    expect(call.url).toBe(`${BASE_URL}/messages`)
    expect(call.headers['x-api-key']).toBe(UPSTREAM_KEY)
    expect(call.headers['anthropic-version']).toBe('2023-06-01')
    expect(call.headers['accept']).toBe('text/event-stream')
  })

  test('a 401 before any byte arrives returns a buffered OpenAI error envelope, not a stream', async () => {
    const responder: UpstreamResponder = () =>
      new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid x-api-key' },
          request_id: 'req_018EeWyXxfu5pfWkrYcMdjWG',
        }),
        { status: 401 },
      )
    upstream.respondWith(responder)
    const { secret } = await createKey([{ providerId: connection.id }])

    const response = await chat(secret, openAiBody())

    expect(response.status).toBe(503)
    expect(response.headers.get('content-type')).toContain('application/json')
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('upstream_credentials_unavailable')
  })

  test('a mid-stream error event emits a chunk with finish_reason and [DONE] but no usage', async () => {
    let held: ReturnType<typeof controlledSse> | undefined
    upstream.respondWith((call) => {
      held = controlledSse(call)
      held.enqueue(anthropicEvent('message_start', messageStart()))
      held.enqueue(anthropicEvent('content_block_start', TEXT_BLOCK_START))
      held.enqueue(anthropicEvent('content_block_delta', textDelta(0, 'Half')))
      held.enqueue(
        anthropicEvent('error', {
          type: 'error',
          error: { type: 'api_error', message: 'server exploded' },
        }),
      )
      held.close()
      return new Response(held.stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const { secret } = await createKey([{ providerId: connection.id }])

    const response = await chat(secret, openAiBody())
    expect(response.status).toBe(200)

    const events = parseSse(await response.text())
    const chunks = events.filter((e) => !e.isDone).map((e) => e.payload as OpenAiChunk)
    const done = events.filter((e) => e.isDone)
    expect(done).toHaveLength(1)
    const final = chunks[chunks.length - 1]!
    // No message_delta arrived, so no usage is emitted; the error chunk is the
    // terminal chunk for this stream.
    expect(final.choices[0]!.finish_reason).toBe('api_error')
    expect(final.usage).toBeUndefined()
    // The previous chunk is still the partial text delta.
    const textChunk = chunks.find((c) => c.choices[0]?.delta.content === 'Half')
    expect(textChunk).toBeDefined()
  })
})

/** Parse the body of an SSE response back into one JSON object per `data:` line. */
function parseSse(body: string): Array<{ payload: unknown; isDone: boolean }> {
  const events = body.split('\n\n').filter((block) => block.length > 0)
  const out: Array<{ payload: unknown; isDone: boolean }> = []
  for (const event of events) {
    const dataLine = event
      .split('\n')
      .find((line) => line.startsWith('data:'))
    if (dataLine === undefined) continue
    const trimmed = dataLine.slice(5).trimStart()
    if (trimmed === '[DONE]') {
      out.push({ payload: null, isDone: true })
      continue
    }
    out.push({ payload: JSON.parse(trimmed) as unknown, isDone: false })
  }
  return out
}
