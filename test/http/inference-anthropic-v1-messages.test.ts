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

const ANTHROPIC_UPSTREAM_KEY = 'sk-ant-api03-anthropic-upstream-key-for-tests-only-0123456789'
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1'
const OPENAI_UPSTREAM_KEY = 'sk-upstream-secret-value-for-tests'
const OPENAI_BASE_URL = 'https://api.openai.com/v1'
const MODEL = 'anthropic-opus-5'

interface ConnectionBody {
  id: string
  handle: string
  displayName: string
  templateId: string | null
}

interface AnthropicMessageBody extends Record<string, unknown> {
  model: string
  max_tokens: number
  messages: Array<Record<string, unknown>>
  system?: unknown
  tools?: unknown
  tool_choice?: unknown
  stream?: boolean
}

function anthropicMessageBody(overrides: Record<string, unknown> = {}): AnthropicMessageBody {
  return {
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  } as AnthropicMessageBody
}

function anthropicSuccessBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'msg_01HelloFromAnthropic',
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content: [{ type: 'text', text: 'Hello from Anthropic' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 12,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    ...overrides,
  })
}

function openAiCompletionBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'chatcmpl-upstream-test',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: MODEL,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Hello from OpenAI' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    ...overrides,
  })
}

function openAiToolCallCompletionBody(): string {
  return JSON.stringify({
    id: 'chatcmpl-tool-call',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: MODEL,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'toolu_01ABCDEF',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: '{"city":"Paris"}',
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 14, completion_tokens: 8, total_tokens: 22 },
  })
}

function anthropicEvent(name: string, payload: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`
}

function openAiEvent(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function openAiDone(): string {
  return 'data: [DONE]\n\n'
}

function parseSse(body: string): Array<{ eventName: string | null; payload: unknown; isDone: boolean }> {
  const events = body.split('\n\n').filter((block) => block.length > 0)
  const out: Array<{ eventName: string | null; payload: unknown; isDone: boolean }> = []
  for (const event of events) {
    let data = ''
    let eventName: string | null = null
    for (const line of event.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim()
      else if (line.startsWith('data:')) data += line.slice(5).trimStart()
    }
    if (data === '[DONE]') {
      out.push({ eventName, payload: null, isDone: true })
      continue
    }
    if (data === '') continue
    try {
      out.push({ eventName, payload: JSON.parse(data) as unknown, isDone: false })
    } catch {
      // skip malformed
    }
  }
  return out
}

describe('Anthropic-compatible /v1/messages public surface', () => {
  let iroha: TestApp
  let csrf: string
  let upstream: ReturnType<typeof mockUpstreamTransport>
  let anthropicConnection: ConnectionBody
  let openAiConnection: ConnectionBody
  let anthropicPath: string
  let openAiPath: string

  beforeEach(async () => {
    upstream = mockUpstreamTransport()
    iroha = await createTestApp({ upstreamTransport: upstream.fetch })
    csrf = (await completeSetup(iroha)).csrf
    anthropicConnection = await createAnthropicConnection()
    openAiConnection = await createOpenAiConnection()
    anthropicPath = `/providers/${anthropicConnection.handle}/v1/messages`
    openAiPath = `/providers/${openAiConnection.handle}/v1/messages`
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  const createAnthropicConnection = async (): Promise<ConnectionBody> => {
    const response = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle: crypto.randomUUID(),
        displayName: 'Anthropic',
        baseUrl: ANTHROPIC_BASE_URL,
        templateId: 'anthropic',
        keys: [{ upstreamKey: ANTHROPIC_UPSTREAM_KEY }],
      }),
      csrf,
    })
    if (response.status !== 201) {
      throw new Error(`Anthropic connection create failed with ${response.status}: ${await response.text()}`)
    }
    return (await response.json()) as ConnectionBody
  }

  const createOpenAiConnection = async (): Promise<ConnectionBody> => {
    const response = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle: crypto.randomUUID(),
        displayName: 'OpenAI',
        baseUrl: OPENAI_BASE_URL,
        templateId: 'openai',
        keys: [{ upstreamKey: OPENAI_UPSTREAM_KEY }],
      }),
      csrf,
    })
    if (response.status !== 201) {
      throw new Error(`OpenAI connection create failed with ${response.status}: ${await response.text()}`)
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

  const messages = (
    path: string,
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

  /* ----- Passthrough against an Anthropic Provider ----- */

  test('passthrough: forwards the Anthropic body verbatim to upstream /v1/messages', async () => {
    upstream.respondWith(() => new Response(anthropicSuccessBody(), { status: 200 }))
    const { secret } = await createKey([{ providerId: anthropicConnection.id }])

    const body = anthropicMessageBody({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      ],
    })
    await messages(anthropicPath, secret, body)

    expect(upstream.calls).toHaveLength(1)
    const call = upstream.calls[0]!
    expect(call.url).toBe(`${ANTHROPIC_BASE_URL}/messages`)
    expect(call.method).toBe('POST')
    // Body is forwarded verbatim.
    const sentBody = JSON.parse(call.body!) as Record<string, unknown>
    expect(sentBody).toEqual(body)
  })

  test('passthrough: returns the Anthropic-shape response verbatim, including streaming', async () => {
    upstream.respondWith(() => new Response(anthropicSuccessBody(), { status: 200 }))
    const { secret } = await createKey([{ providerId: anthropicConnection.id }])

    const response = await messages(anthropicPath, secret, anthropicMessageBody())
    expect(response.status).toBe(200)
    const body = JSON.parse(await response.text()) as Record<string, unknown>
    expect(body.type).toBe('message')
    expect(body.role).toBe('assistant')
    expect(body.model).toBe(MODEL)
    expect(body.content).toEqual([{ type: 'text', text: 'Hello from Anthropic' }])
  })

  test('passthrough: streams the Anthropic SSE events verbatim', async () => {
    const events = [
      { name: 'message_start', payload: { type: 'message_start', message: { id: 'msg_01', type: 'message', role: 'assistant', content: [], model: MODEL, stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } } },
      { name: 'content_block_start', payload: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { name: 'content_block_delta', payload: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } } },
      { name: 'content_block_stop', payload: { type: 'content_block_stop', index: 0 } },
      { name: 'message_delta', payload: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } } },
      { name: 'message_stop', payload: { type: 'message_stop' } },
    ]
    upstream.respondWith(() => sseResponse(events.map((e) => anthropicEvent(e.name, e.payload))))
    const { secret } = await createKey([{ providerId: anthropicConnection.id }])

    const response = await messages(anthropicPath, secret, anthropicMessageBody({ stream: true }))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const body = await response.text()
    // The bytes are forwarded verbatim, so the upstream's content_delta text appears.
    expect(body).toContain('text_delta')
    expect(body).toContain('Hello')
    expect(body).toContain('message_stop')
  })

  test('passthrough: preserves the Anthropic error envelope verbatim on a 401', async () => {
    const responder: UpstreamResponder = () =>
      new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid x-api-key' },
        }),
        { status: 401 },
      )
    upstream.respondWith(responder)
    const { secret } = await createKey([{ providerId: anthropicConnection.id }])

    const response = await messages(anthropicPath, secret, anthropicMessageBody())

    // The 401 marks the key as invalid; for the Anthropic route the retry
    // contract preserves the upstream status and body, surfacing the
    // Anthropic-shape error envelope verbatim so the SDK can parse it.
    expect(response.status).toBe(401)
    expect(response.headers.get('content-type')).toContain('application/json')
    const body = (await response.json()) as Record<string, unknown>
    expect(body.type).toBe('error')
    expect((body.error as Record<string, unknown>).type).toBe('authentication_error')
    expect((body.error as Record<string, unknown>).message).toBe('invalid x-api-key')
    // The Iroha correlation ID propagates as the Anthropic request_id so
    // owners can correlate a SDK error with a server-side log line.
    expect(typeof body.request_id).toBe('string')
    expect((body.request_id as string).length).toBeGreaterThan(0)
  })

  /* ----- Translate against an OpenAI Provider ----- */

  test('translate: translates Anthropic-shape body to OpenAI-shape and calls upstream /chat/completions', async () => {
    upstream.respondWith(() => new Response(openAiCompletionBody(), { status: 200 }))
    const { secret } = await createKey([{ providerId: openAiConnection.id }])

    const body = anthropicMessageBody({
      system: [{ type: 'text', text: 'You are a terse assistant.' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    })
    await messages(openAiPath, secret, body)

    expect(upstream.calls).toHaveLength(1)
    const call = upstream.calls[0]!
    expect(call.url).toBe(`${OPENAI_BASE_URL}/chat/completions`)
    const sent = JSON.parse(call.body!) as Record<string, unknown>
    expect(sent.model).toBe(MODEL)
    expect(sent.messages).toEqual([
      { role: 'system', content: 'You are a terse assistant.' },
      { role: 'user', content: 'Hello' },
    ])
  })

  test('translate: returns the OpenAI-shape response translated to Anthropic-shape', async () => {
    upstream.respondWith(() => new Response(openAiCompletionBody(), { status: 200 }))
    const { secret } = await createKey([{ providerId: openAiConnection.id }])

    const response = await messages(openAiPath, secret, anthropicMessageBody())
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    const body = (await response.json()) as Record<string, unknown>
    expect(body.type).toBe('message')
    expect(body.role).toBe('assistant')
    expect(body.content).toEqual([{ type: 'text', text: 'Hello from OpenAI' }])
    expect(body.stop_reason).toBe('end_turn')
    expect((body.usage as Record<string, unknown>).input_tokens).toBe(12)
    expect((body.usage as Record<string, unknown>).output_tokens).toBe(5)
  })

  test('translate: maps OpenAI finish_reason "tool_calls" to Anthropic stop_reason "tool_use"', async () => {
    upstream.respondWith(() => new Response(openAiToolCallCompletionBody(), { status: 200 }))
    const { secret } = await createKey([{ providerId: openAiConnection.id }])

    const response = await messages(openAiPath, secret, anthropicMessageBody())
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.stop_reason).toBe('tool_use')
    const blocks = body.content as Array<Record<string, unknown>>
    expect(blocks).toHaveLength(1)
    const block = blocks[0]!
    expect(block.type).toBe('tool_use')
    expect(block.id).toBe('toolu_01ABCDEF')
    expect(block.name).toBe('get_weather')
    expect(block.input).toEqual({ city: 'Paris' })
  })

  test('translate: round-trips a tool call from Anthropic-shape request to OpenAI-shape upstream and back', async () => {
    upstream.respondWith(() => new Response(openAiToolCallCompletionBody(), { status: 200 }))
    const { secret } = await createKey([{ providerId: openAiConnection.id }])

    const body = anthropicMessageBody({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'What is the weather in Paris?' }] },
      ],
      tools: [
        {
          name: 'get_weather',
          description: 'Get the current weather for a city.',
          input_schema: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      ],
    })
    await messages(openAiPath, secret, body)

    expect(upstream.calls).toHaveLength(1)
    const sent = JSON.parse(upstream.calls[0]!.body!) as Record<string, unknown>
    const tools = sent.tools as Array<Record<string, unknown>>
    expect(tools).toHaveLength(1)
    const fn = (tools[0]!.function as Record<string, unknown>)
    expect(fn.name).toBe('get_weather')
    expect(fn.parameters).toEqual({
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    })
  })

  test('translate: OpenAI-shape 401 error envelope becomes Anthropic-shape error envelope', async () => {
    const responder: UpstreamResponder = () =>
      new Response(
        JSON.stringify({
          error: {
            message: 'Incorrect API key provided',
            type: 'invalid_request_error',
            param: null,
            code: 'invalid_api_key',
          },
        }),
        { status: 401 },
      )
    upstream.respondWith(responder)
    const { secret } = await createKey([{ providerId: openAiConnection.id }])

    const response = await messages(openAiPath, secret, anthropicMessageBody())

    // The 401 marks the key as invalid; the retry path wraps it.
    expect(response.status).toBe(401)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.type).toBe('error')
    expect((body.error as Record<string, unknown>).type).toBe('authentication_error')
    expect((body.error as Record<string, unknown>).message).toBe('Incorrect API key provided')
    expect(typeof body.request_id).toBe('string')
  })

  /* ----- Streaming translation ----- */

  test('translate: streams OpenAI chunks back as Anthropic SSE events in documented order', async () => {
    const openAiChunks = [
      {
        id: 'chatcmpl-stream-1',
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model: MODEL,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl-stream-1',
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model: MODEL,
        choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl-stream-1',
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model: MODEL,
        choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl-stream-1',
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model: MODEL,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
    ]
    const body = openAiChunks.map(openAiEvent).join('') + openAiDone()
    upstream.respondWith(() => new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))
    const { secret } = await createKey([{ providerId: openAiConnection.id }])

    const response = await messages(openAiPath, secret, anthropicMessageBody({ stream: true }))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const events = parseSse(await response.text())
    const eventNames = events.map((e) => e.eventName).filter((n): n is string => n !== null)

    // Event ordering: message_start first, then content_block_start, then
    // content_block_delta(s), then content_block_stop, then message_delta,
    // then message_stop.
    expect(eventNames[0]).toBe('message_start')
    expect(eventNames[1]).toBe('content_block_start')
    expect(eventNames).toContain('content_block_delta')
    expect(eventNames).toContain('content_block_stop')
    expect(eventNames).toContain('message_delta')
    expect(eventNames[eventNames.length - 1]).toBe('message_stop')

    // The text deltas were merged into the Anthropic-shape stream.
    const deltaText = events
      .filter((e) => e.eventName === 'content_block_delta')
      .map((e) => {
        const data = e.payload as { delta?: { text?: string } }
        return data.delta?.text ?? ''
      })
      .join('')
    expect(deltaText).toBe('Hello world')

    // The message_delta carries the final stop_reason translated from
    // OpenAI's `stop` to Anthropic's `end_turn`.
    const messageDelta = events.find((e) => e.eventName === 'message_delta')
    expect(messageDelta).toBeDefined()
    const delta = (messageDelta!.payload as { delta?: { stop_reason?: string } })
    expect(delta.delta?.stop_reason).toBe('end_turn')
  })

  test('translate: streams a tool-call round-trip as Anthropic content_block tool_use', async () => {
    const openAiChunks = [
      {
        id: 'chatcmpl-tool-stream',
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model: MODEL,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl-tool-stream',
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model: MODEL,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'toolu_01ABCDEF',
              type: 'function',
              function: { name: 'get_weather', arguments: '' },
            }],
          },
          finish_reason: null,
        }],
      },
      {
        id: 'chatcmpl-tool-stream',
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model: MODEL,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: '{"city":' },
            }],
          },
          finish_reason: null,
        }],
      },
      {
        id: 'chatcmpl-tool-stream',
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model: MODEL,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: '"Paris"}' },
            }],
          },
          finish_reason: null,
        }],
      },
      {
        id: 'chatcmpl-tool-stream',
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model: MODEL,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      },
    ]
    const body = openAiChunks.map(openAiEvent).join('') + openAiDone()
    upstream.respondWith(() => new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))
    const { secret } = await createKey([{ providerId: openAiConnection.id }])

    const response = await messages(openAiPath, secret, anthropicMessageBody({ stream: true }))
    const events = parseSse(await response.text())

    const contentBlockStart = events.find((e) => e.eventName === 'content_block_start')
    expect(contentBlockStart).toBeDefined()
    const block = (contentBlockStart!.payload as { content_block?: Record<string, unknown> })
    expect(block.content_block?.type).toBe('tool_use')
    expect(block.content_block?.id).toBe('toolu_01ABCDEF')
    expect(block.content_block?.name).toBe('get_weather')

    // The input_json_delta events accumulate the partial JSON.
    const deltas = events
      .filter((e) => e.eventName === 'content_block_delta')
      .map((e) => {
        const payload = e.payload as { delta?: { partial_json?: string } }
        return payload.delta?.partial_json ?? ''
      })
      .join('')
    expect(deltas).toBe('{"city":"Paris"}')

    // The message_delta carries the final stop_reason translated to "tool_use".
    const messageDelta = events.find((e) => e.eventName === 'message_delta')
    const delta = (messageDelta!.payload as { delta?: { stop_reason?: string } })
    expect(delta.delta?.stop_reason).toBe('tool_use')
  })

  test('translate: a mid-stream disconnect ends the stream instead of replacing it with an error JSON', async () => {
    let held: ReturnType<typeof controlledSse> | undefined
    upstream.respondWith((call) => {
      held = controlledSse(call)
      // OpenAI-shape SSE upstream. The Anthropic-shape caller sees the
      // content translated on its way out; mid-stream disconnects should
      // not inject an error JSON in the middle.
      held.enqueue(openAiEvent({
        id: 'chatcmpl-midstream',
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model: MODEL,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      }))
      held.enqueue(openAiEvent({
        id: 'chatcmpl-midstream',
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model: MODEL,
        choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }],
      }))
      // Mid-stream drop: close before the final finish_reason chunk arrives.
      held.close()
      return new Response(held.stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const { secret } = await createKey([{ providerId: openAiConnection.id }])

    const response = await messages(openAiPath, secret, anthropicMessageBody({ stream: true }))
    expect(response.status).toBe(200)
    const body = await response.text()
    // The Anthropic-shape stream was in flight; the partial content is present.
    expect(body).toContain('Hi')
  })

  /* ----- Edge cases ----- */

  test('rejects a non-JSON body with the stable invalid_request code', async () => {
    const { secret } = await createKey([{ providerId: anthropicConnection.id }])

    const response = await iroha.fetch(anthropicPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: '{not json',
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as Record<string, unknown>
    expect((body.error as Record<string, unknown>).type).toBe('invalid_request')
    expect(upstream.calls).toHaveLength(0)
  })

  test('rejects a missing model with the stable model_required code', async () => {
    const { secret } = await createKey([{ providerId: anthropicConnection.id }])

    const response = await messages(anthropicPath, secret, {
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as Record<string, unknown>
    expect((body.error as Record<string, unknown>).type).toBe('model_required')
    expect(upstream.calls).toHaveLength(0)
  })

  test('missing gateway key returns a stable 401 with gateway_key_invalid', async () => {
    upstream.respondWith(() => new Response(anthropicSuccessBody(), { status: 200 }))

    const response = await messages(anthropicPath, 'bogus-token', anthropicMessageBody())
    expect(response.status).toBe(401)
    const body = (await response.json()) as Record<string, unknown>
    expect((body.error as Record<string, unknown>).type).toBe('gateway_key_invalid')
    expect(upstream.calls).toHaveLength(0)
  })

  test('translate: hits /chat/completions (not /messages) when the target is OpenAI', async () => {
    upstream.respondWith(() => new Response(openAiCompletionBody(), { status: 200 }))
    const { secret } = await createKey([{ providerId: openAiConnection.id }])

    await messages(openAiPath, secret, anthropicMessageBody())

    expect(upstream.calls).toHaveLength(1)
    expect(upstream.calls[0]!.url).toBe(`${OPENAI_BASE_URL}/chat/completions`)
  })

  test('passthrough: hits /messages (not /chat/completions) when the target is Anthropic', async () => {
    upstream.respondWith(() => new Response(anthropicSuccessBody(), { status: 200 }))
    const { secret } = await createKey([{ providerId: anthropicConnection.id }])

    await messages(anthropicPath, secret, anthropicMessageBody())

    expect(upstream.calls).toHaveLength(1)
    expect(upstream.calls[0]!.url).toBe(`${ANTHROPIC_BASE_URL}/messages`)
  })

  test('passthrough: strips hop-by-hop headers and never forwards the Gateway Key', async () => {
    upstream.respondWith(() => new Response(anthropicSuccessBody(), { status: 200 }))
    const { secret } = await createKey([{ providerId: anthropicConnection.id }])

    const response = await iroha.fetch(anthropicPath, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
        cookie: 'session=secret',
        'x-forwarded-for': '203.0.113.9',
        'x-request-id': 'caller-chosen',
        host: 'evil.example',
        'x-custom-header': 'forward-me',
      },
      body: JSON.stringify(anthropicMessageBody()),
    })
    expect(response.status).toBe(200)
    expect(upstream.calls).toHaveLength(1)

    const forwarded = upstream.calls[0]!.headers
    for (const blocked of ['cookie', 'x-forwarded-for', 'x-request-id', 'host']) {
      expect(forwarded[blocked]).toBeUndefined()
    }
    expect(forwarded['x-custom-header']).toBe('forward-me')
    expect(JSON.stringify(forwarded)).not.toContain(secret)
    expect(forwarded['x-api-key']).toBe(ANTHROPIC_UPSTREAM_KEY)
  })
})
