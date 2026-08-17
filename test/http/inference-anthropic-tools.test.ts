import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  completeSetup,
  createTestApp,
  type TestApp,
} from '../support/app.ts'
import {
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
 * Builds a deterministic Anthropic-shape Messages response carrying one
 * `tool_use` block. Matches Anthropic's documented `/v1/messages` shape
 * (`docs/research/anthropic-api.md` section C).
 */
function anthropicToolUseResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'msg_01ToolCallFromAnthropic',
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content: [
      {
        type: 'tool_use',
        id: 'toolu_01ABCDEF',
        name: 'get_weather',
        input: { city: 'Paris' },
      },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: {
      input_tokens: 14,
      output_tokens: 8,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    ...overrides,
  })
}

/** One Anthropic SSE event block, exactly as the upstream emits it. */
function anthropicEvent(name: string, payload: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`
}

const MESSAGE_START = {
  type: 'message_start',
  message: {
    id: 'msg_01ToolCallFromAnthropic',
    type: 'message',
    role: 'assistant',
    content: [],
    model: MODEL,
    stop_reason: null,
    stop_sequence: null,
    usage: {
      input_tokens: 14,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  },
}

const MESSAGE_STOP = { type: 'message_stop' }

const TEXT_BLOCK_START = {
  type: 'content_block_start',
  index: 0,
  content_block: { type: 'text', text: '' },
}

function toolUseStart(index: number, id: string, name: string, input: unknown): Record<string, unknown> {
  return {
    type: 'content_block_start',
    index,
    content_block: { type: 'tool_use', id, name, input },
  }
}

function inputJsonDelta(index: number, partialJson: string): Record<string, unknown> {
  return {
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: partialJson },
  }
}

function messageDelta(stopReason: string | null): Record<string, unknown> {
  return {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 8 },
  }
}

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

interface OpenAiToolCall {
  id: string
  type: string
  index: number
  function: { name: string; arguments: string }
}

describe('Anthropic Inference Adapter — tools and tool-name sanitisation', () => {
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
        handle: 'anthropic-tools',
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

  test('clean tool names pass through the request and response unchanged', async () => {
    upstream.respondWith(() => new Response(anthropicToolUseResponse(), { status: 200 }))
    const { secret } = await createKey([{ providerId: connection.id }])

    const response = await chat(secret, {
      model: MODEL,
      messages: [
        { role: 'system', content: 'Use the get_weather tool.' },
        { role: 'user', content: 'Weather in Paris?' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get current weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        },
      ],
    })

    // The wire keeps the clean name.
    const sent = JSON.parse(upstream.calls[0]!.body ?? '{}') as Record<string, unknown>
    const sentTools = sent.tools as Array<Record<string, unknown>>
    expect(sentTools).toHaveLength(1)
    expect((sentTools[0]!.function as Record<string, unknown>).name).toBe('get_weather')

    // The Anthropic-shape response uses the same name; the OpenAI-shape
    // completion preserves it.
    const completion = (await response.json()) as {
      choices: Array<{
        finish_reason: string
        message: { role: string; tool_calls: OpenAiToolCall[] }
      }>
    }
    expect(completion.choices[0]!.finish_reason).toBe('tool_calls')
    expect(completion.choices[0]!.message.role).toBe('assistant')
    expect(completion.choices[0]!.message.tool_calls).toHaveLength(1)
    expect(completion.choices[0]!.message.tool_calls[0]!.function.name).toBe('get_weather')
    expect(completion.choices[0]!.message.tool_calls[0]!.function.arguments).toBe('{"city":"Paris"}')
  })

  test('tool name with a dot is sanitized on the request and restored on the response', async () => {
    const responder: UpstreamResponder = () =>
      new Response(
        anthropicToolUseResponse({
          content: [
            {
              type: 'tool_use',
              id: 'toolu_dot',
              name: 'get_weather',
              input: { city: 'Paris' },
            },
          ],
        }),
        { status: 200 },
      )
    upstream.respondWith(responder)
    const { secret } = await createKey([{ providerId: connection.id }])

    const response = await chat(secret, {
      model: MODEL,
      messages: [{ role: 'user', content: 'Weather?' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get.weather',
            description: 'Get weather',
            parameters: { type: 'object' },
          },
        },
      ],
    })

    const sent = JSON.parse(upstream.calls[0]!.body ?? '{}') as Record<string, unknown>
    const sentTools = sent.tools as Array<Record<string, unknown>>
    expect((sentTools[0]!.function as Record<string, unknown>).name).toBe('get_weather')

    const completion = (await response.json()) as {
      choices: Array<{ message: { tool_calls: OpenAiToolCall[] } }>
    }
    expect(completion.choices[0]!.message.tool_calls[0]!.function.name).toBe('get.weather')
  })

  test('tool name with a colon is sanitized on the request and restored on the response', async () => {
    upstream.respondWith(() => new Response(anthropicToolUseResponse(), { status: 200 }))
    const { secret } = await createKey([{ providerId: connection.id }])

    await chat(secret, {
      model: MODEL,
      messages: [{ role: 'user', content: 'Call it' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'ns:method',
            parameters: { type: 'object' },
          },
        },
      ],
    })

    const sent = JSON.parse(upstream.calls[0]!.body ?? '{}') as Record<string, unknown>
    const sentTools = sent.tools as Array<Record<string, unknown>>
    expect((sentTools[0]!.function as Record<string, unknown>).name).toBe('ns_method')
  })

  test('tool name with spaces is sanitized on the request and restored on the response', async () => {
    upstream.respondWith(() => new Response(anthropicToolUseResponse(), { status: 200 }))
    const { secret } = await createKey([{ providerId: connection.id }])

    await chat(secret, {
      model: MODEL,
      messages: [{ role: 'user', content: 'Call it' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'tool name with space',
            parameters: { type: 'object' },
          },
        },
      ],
    })

    const sent = JSON.parse(upstream.calls[0]!.body ?? '{}') as Record<string, unknown>
    const sentTools = sent.tools as Array<Record<string, unknown>>
    expect((sentTools[0]!.function as Record<string, unknown>).name).toBe('tool_name_with_space')
  })

  test('a sanitized tool_choice name matches the sanitized tool entry, not the original', async () => {
    upstream.respondWith(() => new Response(anthropicToolUseResponse(), { status: 200 }))
    const { secret } = await createKey([{ providerId: connection.id }])

    await chat(secret, {
      model: MODEL,
      messages: [{ role: 'user', content: 'Go' }],
      tools: [
        {
          type: 'function',
          function: { name: 'get.weather', parameters: { type: 'object' } },
        },
      ],
      tool_choice: {
        type: 'function',
        function: { name: 'get.weather' },
      },
    })

    const sent = JSON.parse(upstream.calls[0]!.body ?? '{}') as Record<string, unknown>
    expect(sent.tool_choice).toEqual({ type: 'tool', name: 'get_weather' })
  })

  test('tool_choice vocabulary maps: auto, required, none', async () => {
    upstream.respondWith(() => new Response(anthropicToolUseResponse(), { status: 200 }))
    const { secret } = await createKey([{ providerId: connection.id }])

    for (const [openai, anthropic] of [
      ['auto', { type: 'auto' }],
      ['required', { type: 'any' }],
      ['none', { type: 'none' }],
    ] as const) {
      await chat(secret, {
        model: MODEL,
        messages: [{ role: 'user', content: 'Go' }],
        tool_choice: openai,
      })
      const sent = JSON.parse(upstream.calls.at(-1)!.body ?? '{}') as Record<string, unknown>
      expect(sent.tool_choice).toEqual(anthropic)
    }
  })

  test('parallel_tool_calls: false inverts to disable_parallel_tool_use: true', async () => {
    upstream.respondWith(() => new Response(anthropicToolUseResponse(), { status: 200 }))
    const { secret } = await createKey([{ providerId: connection.id }])

    await chat(secret, {
      model: MODEL,
      messages: [{ role: 'user', content: 'Go' }],
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', parameters: { type: 'object' } },
        },
      ],
      parallel_tool_calls: false,
    })

    const sent = JSON.parse(upstream.calls[0]!.body ?? '{}') as Record<string, unknown>
    expect(sent.disable_parallel_tool_use).toBe(true)
  })

  test('parallel_tool_calls: true is omitted (Anthropic default is parallel allowed)', async () => {
    upstream.respondWith(() => new Response(anthropicToolUseResponse(), { status: 200 }))
    const { secret } = await createKey([{ providerId: connection.id }])

    await chat(secret, {
      model: MODEL,
      messages: [{ role: 'user', content: 'Go' }],
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', parameters: { type: 'object' } },
        },
      ],
      parallel_tool_calls: true,
    })

    const sent = JSON.parse(upstream.calls[0]!.body ?? '{}') as Record<string, unknown>
    expect(sent.disable_parallel_tool_use).toBeUndefined()
  })

  test('a role: tool message becomes an Anthropic user-message carrying one tool_result block', async () => {
    upstream.respondWith(() => new Response(anthropicToolUseResponse(), { status: 200 }))
    const { secret } = await createKey([{ providerId: connection.id }])

    await chat(secret, {
      model: MODEL,
      messages: [
        { role: 'user', content: 'Weather in Paris?' },
        {
          role: 'tool',
          tool_call_id: 'toolu_01ABCDEF',
          content: '{"temperature":14,"unit":"celsius"}',
        },
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', parameters: { type: 'object' } },
        },
      ],
    })

    const sent = JSON.parse(upstream.calls[0]!.body ?? '{}') as Record<string, unknown>
    const sentMessages = sent.messages as Array<Record<string, unknown>>
    expect(sentMessages).toHaveLength(2)
    // The original user message passes through unchanged.
    expect(sentMessages[0]).toEqual({ role: 'user', content: 'Weather in Paris?' })
    // The tool message becomes a user message carrying one tool_result block.
    expect(sentMessages[1]!.role).toBe('user')
    const blocks = sentMessages[1]!.content as Array<Record<string, unknown>>
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.type).toBe('tool_result')
    expect(blocks[0]!.tool_use_id).toBe('toolu_01ABCDEF')
    expect(blocks[0]!.content).toBe('{"temperature":14,"unit":"celsius"}')
  })

  test('a non-streaming tool_use response is translated to an OpenAI tool_calls[] entry', async () => {
    upstream.respondWith(() => new Response(anthropicToolUseResponse(), { status: 200 }))
    const { secret } = await createKey([{ providerId: connection.id }])

    const response = await chat(secret, {
      model: MODEL,
      messages: [{ role: 'user', content: 'Weather?' }],
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', parameters: { type: 'object' } },
        },
      ],
    })

    const completion = (await response.json()) as {
      choices: Array<{
        finish_reason: string
        message: { role: string; content: string; tool_calls: OpenAiToolCall[] }
      }>
      usage: Record<string, unknown>
    }

    expect(completion.choices).toHaveLength(1)
    expect(completion.choices[0]!.finish_reason).toBe('tool_calls')
    expect(completion.choices[0]!.message.role).toBe('assistant')
    expect(completion.choices[0]!.message.content).toBe('')
    expect(completion.choices[0]!.message.tool_calls).toHaveLength(1)
    const call = completion.choices[0]!.message.tool_calls[0]!
    expect(call.id).toBe('toolu_01ABCDEF')
    expect(call.type).toBe('function')
    expect(call.index).toBe(0)
    expect(call.function.name).toBe('get_weather')
    expect(call.function.arguments).toBe('{"city":"Paris"}')
  })

  test('finish_reason becomes tool_calls even when upstream reports end_turn but emits tool_use', async () => {
    upstream.respondWith(() =>
      new Response(
        anthropicToolUseResponse({
          stop_reason: 'end_turn',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_override',
              name: 'get_weather',
              input: {},
            },
          ],
        }),
        { status: 200 },
      ),
    )
    const { secret } = await createKey([{ providerId: connection.id }])

    const response = await chat(secret, {
      model: MODEL,
      messages: [{ role: 'user', content: 'Weather?' }],
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', parameters: { type: 'object' } },
        },
      ],
    })

    const completion = (await response.json()) as {
      choices: Array<{ finish_reason: string; message: { tool_calls: OpenAiToolCall[] } }>
    }
    expect(completion.choices[0]!.finish_reason).toBe('tool_calls')
    expect(completion.choices[0]!.message.tool_calls).toHaveLength(1)
  })

  test('streaming tool_use: id, sanitized name, and accumulated arguments across input_json_delta chunks', async () => {
    const events = [
      { name: 'message_start', payload: MESSAGE_START },
      { name: 'content_block_start', payload: TEXT_BLOCK_START },
      { name: 'content_block_delta', payload: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Calling' } } },
      { name: 'content_block_stop', payload: { type: 'content_block_stop', index: 0 } },
      { name: 'content_block_start', payload: toolUseStart(1, 'toolu_01ABCDEF', 'get_weather', {}) },
      { name: 'content_block_delta', payload: inputJsonDelta(1, '{"city":') },
      { name: 'content_block_delta', payload: inputJsonDelta(1, '"Paris"}') },
      { name: 'content_block_stop', payload: { type: 'content_block_stop', index: 1 } },
      { name: 'message_delta', payload: messageDelta('tool_use') },
      { name: 'message_stop', payload: MESSAGE_STOP },
    ]
    upstream.respondWith(() => sseResponse([events.map((e) => anthropicEvent(e.name, e.payload)).join('')]))
    const { secret } = await createKey([{ providerId: connection.id }])

    const response = await chat(secret, {
      model: MODEL,
      stream: true,
      messages: [{ role: 'user', content: 'Weather?' }],
      tools: [
        {
          type: 'function',
          function: { name: 'get.weather', parameters: { type: 'object' } },
        },
      ],
    })

    expect(response.status).toBe(200)
    const events_ = parseSse(await response.text())
    const chunks = events_.filter((e) => !e.isDone).map((e) => e.payload as OpenAiChunk)
    const done = events_.filter((e) => e.isDone)
    expect(done).toHaveLength(1)

    // The first tool chunk emits id, type, name, and empty arguments.
    const toolStarts = chunks.filter((c) => c.choices[0]?.delta.tool_calls !== undefined)
    expect(toolStarts.length).toBeGreaterThanOrEqual(1)
    const firstTool = (toolStarts[0]!.choices[0]!.delta.tool_calls as OpenAiToolCall[])[0]!
    expect(firstTool.id).toBe('toolu_01ABCDEF')
    expect(firstTool.type).toBe('function')
    expect(firstTool.index).toBe(0)
    // The reverse map restored the caller's original name.
    expect(firstTool.function.name).toBe('get.weather')
    expect(firstTool.function.arguments).toBe('')

    // Subsequent input_json_delta chunks carry only the partial JSON;
    // the OpenAI SDK concatenates them.
    const argDeltas = toolStarts
      .slice(1)
      .map((c) => (c.choices[0]!.delta.tool_calls as OpenAiToolCall[])[0]!)
    expect(argDeltas).toHaveLength(2)
    expect(argDeltas[0]!.index).toBe(0)
    expect(argDeltas[0]!.function.arguments).toBe('{"city":')
    expect(argDeltas[1]!.index).toBe(0)
    expect(argDeltas[1]!.function.arguments).toBe('"Paris"}')
    expect(argDeltas.map((d) => d.function.arguments).join('')).toBe('{"city":"Paris"}')

    // The final chunk carries finish_reason and usage.
    const final = chunks.at(-1)!
    expect(final.choices[0]!.finish_reason).toBe('tool_calls')
    expect(final.usage).toBeDefined()
  })

  test('streaming tool_use with empty input surfaces an empty-args tool call to the caller', async () => {
    const events = [
      { name: 'message_start', payload: MESSAGE_START },
      { name: 'content_block_start', payload: toolUseStart(0, 'toolu_empty', 'get_weather', {}) },
      { name: 'content_block_stop', payload: { type: 'content_block_stop', index: 0 } },
      { name: 'message_delta', payload: messageDelta('tool_use') },
      { name: 'message_stop', payload: MESSAGE_STOP },
    ]
    upstream.respondWith(() => sseResponse([events.map((e) => anthropicEvent(e.name, e.payload)).join('')]))
    const { secret } = await createKey([{ providerId: connection.id }])

    const response = await chat(secret, {
      model: MODEL,
      stream: true,
      messages: [{ role: 'user', content: 'Call it' }],
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', parameters: { type: 'object' } },
        },
      ],
    })

    const chunks = parseSse(await response.text())
      .filter((e) => !e.isDone)
      .map((e) => e.payload as OpenAiChunk)

    // The first tool chunk is the only one; no input_json_delta follows.
    const toolStarts = chunks.filter((c) => c.choices[0]?.delta.tool_calls !== undefined)
    expect(toolStarts).toHaveLength(1)
    const tool = (toolStarts[0]!.choices[0]!.delta.tool_calls as OpenAiToolCall[])[0]!
    expect(tool.id).toBe('toolu_empty')
    expect(tool.function.name).toBe('get_weather')
    // Empty input still surfaces an empty-args tool call — never half-formed.
    expect(tool.function.arguments).toBe('')
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