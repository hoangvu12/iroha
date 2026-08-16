import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { completeSetup, createTestApp, type TestApp } from '../support/app.ts'
import { controlledSse, mockUpstreamTransport, sseResponse } from '../support/inference.ts'

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1'
const OPENAI_BASE = 'https://api.openai.com/v1'
const ANTHROPIC_HANDLE = 'anthropic'
const OPENAI_HANDLE = 'openai'

function anthropicEvent(name: string, payload: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`
}

describe('global Anthropic Messages', () => {
  let iroha: TestApp
  let csrf: string
  let upstream: ReturnType<typeof mockUpstreamTransport>
  let anthropicId: string
  let openAiId: string
  let secret: string

  beforeEach(async () => {
    upstream = mockUpstreamTransport()
    iroha = await createTestApp({ upstreamTransport: upstream.fetch })
    csrf = (await completeSetup(iroha)).csrf
    anthropicId = await createProvider('Anthropic', 'anthropic', ANTHROPIC_BASE, 'sk-ant-global')
    openAiId = await createProvider('OpenAI', 'openai', OPENAI_BASE, 'sk-openai-global')
    secret = await createKey([{ providerId: anthropicId }, { providerId: openAiId }])
  })

  afterEach(async () => await iroha.dispose())

  test('direct Anthropic passthrough preserves a nested model and qualifies the served model', async () => {
    upstream.respondWith(() => Response.json({
      id: 'msg_direct', type: 'message', role: 'assistant', model: 'served/alias',
      content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 1 },
    }))

    const response = await messages({ model: `${ANTHROPIC_HANDLE}/claude/nested`, max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] })
    expect(response.status).toBe(200)
    expect(((await response.json()) as { model: string }).model).toBe(`${ANTHROPIC_HANDLE}/served/alias`)
    expect(JSON.parse(upstream.calls[0]!.body ?? '{}')).toMatchObject({ model: 'claude/nested' })
    expect(upstream.calls[0]!.url).toBe(`${ANTHROPIC_BASE}/messages`)
  })

  test('translated OpenAI round trip falls back to the requested Qualified Model ID', async () => {
    upstream.respondWith(() => Response.json({
      id: 'chatcmpl_translated', object: 'chat.completion', created: 1,
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }))
    const requested = `${OPENAI_HANDLE}/vendor/future/model`

    const response = await messages({ model: requested, max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] })
    expect(response.status).toBe(200)
    expect(((await response.json()) as { model: string }).model).toBe(requested)
    expect(JSON.parse(upstream.calls[0]!.body ?? '{}')).toMatchObject({ model: 'vendor/future/model' })
    expect(upstream.calls[0]!.url).toBe(`${OPENAI_BASE}/chat/completions`)
  })

  test('qualifies direct Anthropic and translated OpenAI streaming message_start models', async () => {
    upstream.respondWith((call) => call.url.includes('anthropic.com')
      ? sseResponse([
          anthropicEvent('message_start', { type: 'message_start', message: { id: 'msg_stream', type: 'message', role: 'assistant', model: 'served/direct', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
          anthropicEvent('message_stop', { type: 'message_stop' }),
        ])
      : sseResponse([
          `data: ${JSON.stringify({ id: 'chat_stream', object: 'chat.completion.chunk', model: 'served/translated', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`,
          'data: [DONE]\n\n',
        ]))

    const direct = await messages({ model: `${ANTHROPIC_HANDLE}/nested/direct`, max_tokens: 64, messages: [], stream: true })
    expect(await direct.text()).toContain(`"model":"${ANTHROPIC_HANDLE}/served/direct"`)
    const translated = await messages({ model: `${OPENAI_HANDLE}/nested/translated`, max_tokens: 64, messages: [], stream: true })
    expect(await translated.text()).toContain(`"model":"${OPENAI_HANDLE}/served/translated"`)
  })

  test('uses Anthropic error envelopes and sends no upstream traffic for invalid or unauthorized routing', async () => {
    const malformed = await messages({ model: 'unqualified', max_tokens: 1, messages: [] })
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({ type: 'error', error: { type: 'invalid_model_id' } })

    const invalidHandle = await messages({ model: 'INVALID/model', max_tokens: 1, messages: [] })
    expect(invalidHandle.status).toBe(400)
    expect(await invalidHandle.json()).toMatchObject({ type: 'error', error: { type: 'invalid_model_id' } })

    const invalidKey = await messages({ model: `${ANTHROPIC_HANDLE}/model`, max_tokens: 1, messages: [] }, 'gk_absent.wrong')
    expect(invalidKey.status).toBe(401)
    expect(await invalidKey.json()).toMatchObject({ type: 'error', error: { type: 'gateway_key_invalid' } })

    const absent = await messages({ model: 'absent/model', max_tokens: 1, messages: [] })
    expect(absent.status).toBe(403)
    expect(await absent.json()).toMatchObject({ type: 'error', error: { type: 'provider_not_allowed' } })

    const restricted = await createKey([{ providerId: anthropicId, models: ['allowed'] }])
    const denied = await messages({ model: `${ANTHROPIC_HANDLE}/denied`, max_tokens: 1, messages: [] }, restricted)
    expect(denied.status).toBe(403)
    expect(upstream.calls).toHaveLength(0)
  })

  test('keeps the provider-scoped Messages model contract unqualified', async () => {
    upstream.respondWith(() => Response.json({
      id: 'msg_scoped', type: 'message', role: 'assistant', model: 'served/scoped', content: [],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
    }))
    const response = await iroha.fetch(`/providers/${ANTHROPIC_HANDLE}/v1/messages`, {
      method: 'POST', headers: headers(secret),
      body: JSON.stringify({ model: 'nested/scoped', max_tokens: 8, messages: [] }),
    })
    expect(response.status).toBe(200)
    expect(((await response.json()) as { model: string }).model).toBe('served/scoped')
  })

  test('translated tools, structured output, usage, retry, and history retain their provider-scoped behavior', async () => {
    let attempts = 0
    upstream.respondWith(() => {
      attempts += 1
      if (attempts === 1) return new Response('{"error":{"message":"temporary"}}', { status: 503 })
      return Response.json({
        id: 'chatcmpl_tool', object: 'chat.completion', created: 1, model: 'served/tool-model',
        choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_weather', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      })
    })
    const response = await messages({
      model: `${OPENAI_HANDLE}/nested/tools`, max_tokens: 64,
      messages: [{ role: 'user', content: 'weather?' }],
      tools: [{ name: 'get_weather', description: 'Weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
      tool_choice: { type: 'tool', name: 'get_weather' },
      output_config: { format: { type: 'json_schema', name: 'weather', schema: { type: 'object' } } },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { model: string; stop_reason: string; content: Array<Record<string, unknown>>; usage: Record<string, number> }
    expect(body.model).toBe(`${OPENAI_HANDLE}/served/tool-model`)
    expect(body.stop_reason).toBe('tool_use')
    expect(body.content[0]).toMatchObject({ type: 'tool_use', id: 'toolu_weather', name: 'get_weather', input: { city: 'Paris' } })
    expect(body.usage).toMatchObject({ input_tokens: 7, output_tokens: 3 })
    expect(upstream.calls).toHaveLength(2)
    const forwarded = JSON.parse(upstream.calls[1]!.body ?? '{}') as Record<string, unknown>
    expect(forwarded).toMatchObject({ model: 'nested/tools', tool_choice: { type: 'function', function: { name: 'get_weather' } } })
    expect(forwarded.response_format).toMatchObject({ type: 'json_schema' })

    const requestId = response.headers.get('x-request-id')
    const history = await iroha.fetch(`/api/v1/admin/requests/${requestId}`)
    expect(history.status).toBe(200)
    expect(((await history.json()) as { attempts: unknown[] }).attempts).toHaveLength(2)
  })

  test('caller cancellation aborts a globally qualified Anthropic stream', async () => {
    upstream.respondWith((call) => {
      const held = controlledSse(call)
      held.enqueue(anthropicEvent('message_start', { type: 'message_start', message: { id: 'msg_cancel', type: 'message', role: 'assistant', model: 'served/cancel', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }))
      return new Response(held.stream, { headers: { 'content-type': 'text/event-stream' } })
    })
    const controller = new AbortController()
    const response = await iroha.fetch('/v1/messages', {
      method: 'POST', headers: headers(secret), signal: controller.signal,
      body: JSON.stringify({ model: `${ANTHROPIC_HANDLE}/nested/cancel`, max_tokens: 8, messages: [], stream: true }),
    })
    const reading = response.text()
    await Bun.sleep(0)
    expect(upstream.calls[0]?.signal?.aborted).toBe(false)
    controller.abort()
    expect(upstream.calls[0]?.signal?.aborted).toBe(true)
    await reading
  })

  async function createProvider(name: string, templateId: string, baseUrl: string, upstreamKey: string): Promise<string> {
    const response = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: name, handle: name.toLowerCase(), templateId, baseUrl, keys: [{ upstreamKey }] }), csrf,
    })
    if (response.status !== 201) throw new Error(`Provider create failed: ${await response.text()}`)
    return ((await response.json()) as { id: string }).id
  }

  async function createKey(scope: unknown[]): Promise<string> {
    const response = await iroha.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Global Messages client', scope }), csrf,
    })
    return ((await response.json()) as { secret: string }).secret
  }

  function headers(token: string): Record<string, string> {
    return { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' }
  }

  function messages(body: unknown, token = secret): Promise<Response> {
    return iroha.fetch('/v1/messages', { method: 'POST', headers: headers(token), body: JSON.stringify(body) })
  }
})
