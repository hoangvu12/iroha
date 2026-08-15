import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  completeSetup,
  createTestApp,
  type TestApp,
} from '../support/app.ts'
import {
  mockUpstreamTransport,
  type UpstreamResponder,
} from '../support/inference.ts'

const UPSTREAM_KEY = 'sk-ant-api03-anthropic-upstream-key-for-tests-only-0123456789'
const MODEL = 'anthropic-opus-5'
const BASE_URL = 'https://api.anthropic.com/v1'

interface ConnectionBody {
  id: string
  displayName: string
  templateId: string | null
}

/**
 * The OpenAI-shape Chat Completions body the test sends to
 * `/providers/{id}/v1/chat/completions`. Kept text-only: streaming, tools,
 * images, and structured outputs are added by later tickets and the skeleton
 * adapter does not claim to translate them yet.
 */
function openAiBody(model: string = MODEL): Record<string, unknown> {
  return {
    model,
    messages: [
      { role: 'system', content: 'You are a terse assistant.' },
      { role: 'user', content: 'Say hello' },
    ],
    temperature: 0.7,
  }
}

/**
 * Builds a deterministic Anthropic-shape Messages success response. The body
 * matches Anthropic's documented `/v1/messages` success shape
 * (`docs/research/anthropic-api.md` section C): `id` (`msg_*`), `type:
 * "message"`, `role: "assistant"`, `model`, `content: [{type: "text", ...}]`,
 * `stop_reason`, `usage`.
 */
function anthropicSuccessBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'msg_01HelloFromAnthropic',
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content: [{ type: 'text', text: 'Hello from Anthropic', citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    container: null,
    usage: {
      input_tokens: 12,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      output_tokens_details: { thinking_tokens: 0 },
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      inference_geo: null,
      service_tier: 'standard',
    },
    ...overrides,
  })
}

describe('Anthropic Inference Adapter — non-streaming Chat Completions', () => {
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
    path = `/providers/${connection.id}/v1/chat/completions`
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
    token: string | null,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) =>
    iroha.fetch(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...headers,
      },
      body: JSON.stringify(body),
    })

  test('the request URL is the Anthropic Messages endpoint, not OpenAI Chat Completions', async () => {
    upstream.respondWith(() => new Response(anthropicSuccessBody(), { status: 200 }))
    const { secret } = await createKey([{ providerId: connection.id }])

    await chat(secret, openAiBody())

    expect(upstream.calls).toHaveLength(1)
    const call = upstream.calls[0]!
    expect(call.url).toBe(`${BASE_URL}/messages`)
    expect(call.method).toBe('POST')
  })

  test('injects x-api-key with the empty authPrefix and the configured anthropic-version', async () => {
    upstream.respondWith(() => new Response(anthropicSuccessBody(), { status: 200 }))
    const { secret } = await createKey([{ providerId: connection.id }])

    await chat(secret, openAiBody())

    const headers = upstream.calls[0]!.headers
    // The Anthropic template ships `authHeader: "x-api-key"` and
    // `authPrefix: ""`; the adapter must use exactly that combination.
    expect(headers['x-api-key']).toBe(UPSTREAM_KEY)
    expect(headers['authorization']).toBeUndefined()
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['content-type']).toBe('application/json')
    expect(headers['accept']).toBe('application/json')
  })

  test("honors the caller's anthropic-version header when present", async () => {
    upstream.respondWith(() => new Response(anthropicSuccessBody(), { status: 200 }))
    const { secret } = await createKey([{ providerId: connection.id }])

    await chat(secret, openAiBody(), { 'anthropic-version': '2099-12-31' })

    expect(upstream.calls[0]!.headers['anthropic-version']).toBe('2099-12-31')
  })

  test('hoists system messages to the top-level `system` field as text blocks', async () => {
    upstream.respondWith(() => new Response(anthropicSuccessBody(), { status: 200 }))
    const { secret } = await createKey([{ providerId: connection.id }])

    await chat(secret, openAiBody())

    const body = JSON.parse(upstream.calls[0]!.body!) as Record<string, unknown>
    expect(body.messages).toEqual([{ role: 'user', content: 'Say hello' }])
    expect(body.system).toEqual([
      { type: 'text', text: 'You are a terse assistant.' },
    ])
    expect(body.model).toBe(MODEL)
  })

  test('defaults max_tokens from the per-model table when the caller omitted it', async () => {
    upstream.respondWith(() => new Response(anthropicSuccessBody(), { status: 200 }))
    const { secret } = await createKey([{ providerId: connection.id }])

    await chat(secret, openAiBody('anthropic-opus-5'))

    const body = JSON.parse(upstream.calls[0]!.body!) as Record<string, unknown>
    expect(body.max_tokens).toBe(32_000)
  })

  test('preserves the caller-supplied max_tokens verbatim', async () => {
    upstream.respondWith(() => new Response(anthropicSuccessBody(), { status: 200 }))
    const { secret } = await createKey([{ providerId: connection.id }])

    await chat(secret, { ...openAiBody(), max_tokens: 1024 })

    const body = JSON.parse(upstream.calls[0]!.body!) as Record<string, unknown>
    expect(body.max_tokens).toBe(1024)
  })

  test('falls back to DEFAULT_ANTHROPIC_MAX_TOKENS for unknown models', async () => {
    upstream.respondWith(() => new Response(anthropicSuccessBody(), { status: 200 }))
    const { secret } = await createKey([{ providerId: connection.id }])

    await chat(secret, openAiBody('anthropic-unknown-future-model'))

    const body = JSON.parse(upstream.calls[0]!.body!) as Record<string, unknown>
    expect(body.max_tokens).toBe(4096)
  })

  test('translates the Anthropic response into the OpenAI Chat Completions shape', async () => {
    upstream.respondWith(() => new Response(anthropicSuccessBody(), { status: 200 }))
    const { secret } = await createKey([{ providerId: connection.id }])

    const response = await chat(secret, openAiBody())
    expect(response.status).toBe(200)

    const completion = (await response.json()) as {
      id: string
      object: string
      model: string
      choices: { index: number; message: { role: string; content: string }; finish_reason: string }[]
      usage: {
        prompt_tokens: number
        completion_tokens: number
        total_tokens: number
      }
    }

    expect(completion.id).toBe('msg_01HelloFromAnthropic')
    expect(completion.object).toBe('chat.completion')
    expect(completion.model).toBe(MODEL)
    expect(completion.choices).toHaveLength(1)
    const choice = completion.choices[0]!
    expect(choice.index).toBe(0)
    expect(choice.message.role).toBe('assistant')
    expect(choice.message.content).toBe('Hello from Anthropic')
    // Anthropic `end_turn` → OpenAI `stop`.
    expect(choice.finish_reason).toBe('stop')
    // Usage: Anthropic input_tokens → prompt_tokens, output_tokens →
    // completion_tokens. The Anthropic total is the sum of input_tokens,
    // cache_creation_input_tokens, cache_read_input_tokens, and
    // output_tokens.
    expect(completion.usage.prompt_tokens).toBe(12)
    expect(completion.usage.completion_tokens).toBe(5)
    expect(completion.usage.total_tokens).toBe(17)
  })

  test('maps max_tokens stop_reason to OpenAI length', async () => {
    upstream.respondWith(() =>
      new Response(
        anthropicSuccessBody({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'partial...' }] }),
        { status: 200 },
      ),
    )
    const { secret } = await createKey([{ providerId: connection.id }])

    const response = await chat(secret, openAiBody())
    const completion = (await response.json()) as { choices: { finish_reason: string }[] }
    expect(completion.choices[0]!.finish_reason).toBe('length')
  })

  test('maps refusal stop_reason to OpenAI content_filter', async () => {
    upstream.respondWith(() =>
      new Response(anthropicSuccessBody({ stop_reason: 'refusal' }), { status: 200 }),
    )
    const { secret } = await createKey([{ providerId: connection.id }])

    const response = await chat(secret, openAiBody())
    const completion = (await response.json()) as { choices: { finish_reason: string }[] }
    expect(completion.choices[0]!.finish_reason).toBe('content_filter')
  })

  test('surfaces Anthropic cache and thinking tokens in OpenAI usage fields', async () => {
    upstream.respondWith(() =>
      new Response(
        anthropicSuccessBody({
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 30,
            cache_read_input_tokens: 20,
            output_tokens_details: { thinking_tokens: 12 },
            server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
          },
        }),
        { status: 200 },
      ),
    )
    const { secret } = await createKey([{ providerId: connection.id }])

    const response = await chat(secret, openAiBody())
    const completion = (await response.json()) as {
      usage: Record<string, unknown>
    }

    // prompt_tokens reflects only the input_tokens Anthropic billed; the
    // Anthropic total tokens is input + cache_creation + cache_read +
    // output. Mirroring the cache tokens and surfacing cached_tokens lets
    // OpenAI SDKs that key off Anthropic-shaped telemetry see the same
    // values they would from a direct Anthropic call.
    expect(completion.usage.prompt_tokens).toBe(100)
    expect(completion.usage.completion_tokens).toBe(50)
    expect(completion.usage.total_tokens).toBe(200)
    expect(completion.usage.cache_creation_input_tokens).toBe(30)
    expect(completion.usage.cache_read_input_tokens).toBe(20)
    expect((completion.usage.prompt_tokens_details as { cached_tokens: number }).cached_tokens).toBe(50)
    expect((completion.usage.completion_tokens_details as { reasoning_tokens: number }).reasoning_tokens).toBe(12)
  })

  test('maps an Anthropic error envelope to an OpenAI error envelope, preserving status', async () => {
    const upstreamResponder: UpstreamResponder = () =>
      new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid x-api-key' },
          request_id: 'req_018EeWyXxfu5pfWkrYcMdjWG',
        }),
        { status: 401 },
      )
    upstream.respondWith(upstreamResponder)
    const { secret } = await createKey([{ providerId: connection.id }])

    const response = await chat(secret, openAiBody())

    // The 401 marks the key as invalid; with only one key, the second
    // attempt has no eligible key and the Iroha retry contract wraps the
    // upstream response in `upstream_credentials_unavailable`.
    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('upstream_credentials_unavailable')
    // The request_id is propagated through the retry chain.
    expect(response.headers.get('x-request-id')).toMatch(/^req_/)
  })

  test('maps a rate-limit error to 503 with retry-after preserved', async () => {
    const upstreamResponder: UpstreamResponder = () =>
      new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'rate_limit_error', message: 'slow down' },
          request_id: 'req_rate',
        }),
        { status: 429, headers: { 'retry-after': '12' } },
      )
    upstream.respondWith(upstreamResponder)
    const { secret } = await createKey([{ providerId: connection.id }])

    const response = await chat(secret, openAiBody())

    // 429 with one key triggers the rate-limit alternate-key retry; the
    // Iroha envelope wraps the upstream 429 in `upstream_credentials_unavailable`.
    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('12')
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('upstream_credentials_unavailable')
  })

  test('rejects a non-JSON body with the stable invalid_request code', async () => {
    const { secret } = await createKey([{ providerId: connection.id }])

    const response = await iroha.fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: '{not json',
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('invalid_request')
    // The adapter never reached the upstream; the failure is purely local.
    expect(upstream.calls).toHaveLength(0)
  })

  test('rejects a missing model with the stable model_required code', async () => {
    const { secret } = await createKey([{ providerId: connection.id }])

    const response = await chat(secret, {
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('model_required')
    expect(upstream.calls).toHaveLength(0)
  })

  test('strips hop-by-hop headers and never forwards the Gateway Key', async () => {
    upstream.respondWith(() => new Response(anthropicSuccessBody(), { status: 200 }))
    const { secret } = await createKey([{ providerId: connection.id }])

    // The iroha.fetch helper always sets `origin: ORIGIN` (same-origin
    // browser). We deliberately avoid an explicit `origin` header here so the
    // request stays same-origin and CORS doesn't intercept; the other
    // headers exercise the blocked-list the adapter owns.
    const response = await iroha.fetch(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
        cookie: 'session=secret',
        'x-forwarded-for': '203.0.113.9',
        'x-real-ip': '198.51.100.2',
        'x-request-id': 'caller-chosen',
        host: 'evil.example',
        'x-custom-header': 'forward-me',
      },
      body: JSON.stringify(openAiBody()),
    })
    expect(response.status).toBe(200)
    expect(upstream.calls).toHaveLength(1)

    const forwarded = upstream.calls[0]!.headers
    for (const blocked of ['cookie', 'x-forwarded-for', 'x-real-ip', 'x-request-id', 'host']) {
      expect(forwarded[blocked]).toBeUndefined()
    }
    expect(forwarded['x-custom-header']).toBe('forward-me')
    expect(JSON.stringify(forwarded)).not.toContain(secret)
    expect(forwarded['x-api-key']).toBe(UPSTREAM_KEY)
  })
})
