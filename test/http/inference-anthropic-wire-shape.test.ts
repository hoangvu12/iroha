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

/**
 * Regression coverage for ADR-0020: the provider-scoped Anthropic messages
 * surface must decide passthrough-vs-translate from the Provider Template's
 * declared `wireFormat`, not from a brand-string comparison against the
 * literal `anthropic`. The shipped `generic-anthropic-compatible` Template
 * speaks the Anthropic shape and must pass a caller's body through verbatim.
 */

const ANTHROPIC_UPSTREAM_KEY = 'sk-ant-api03-anthropic-upstream-key-for-tests-only-0123456789'
// A bespoke Anthropic-speaking proxy seeded from the generic Anthropic template.
const GENERIC_ANTHROPIC_BASE_URL = 'https://anthropic-proxy.example.com/v1'
const FIRST_PARTY_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1'
const OPENAI_UPSTREAM_KEY = 'sk-upstream-secret-value-for-tests'
const OPENAI_BASE_URL = 'https://api.openai.com/v1'
const NO_TEMPLATE_BASE_URL = 'https://byo.example.com/v1'
const MODEL = 'anthropic-opus-5'

interface ConnectionBody {
  id: string
  handle: string
  displayName: string
  templateId: string | null
}

function anthropicMessageBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    ...overrides,
  }
}

function anthropicSuccessBody(): string {
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
  })
}

function openAiCompletionBody(): string {
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
  })
}

function anthropicEvent(name: string, payload: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`
}

const anthropicStreamEvents = [
  { name: 'message_start', payload: { type: 'message_start', message: { id: 'msg_01', type: 'message', role: 'assistant', content: [], model: MODEL, stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } } },
  { name: 'content_block_start', payload: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  { name: 'content_block_delta', payload: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } } },
  { name: 'content_block_stop', payload: { type: 'content_block_stop', index: 0 } },
  { name: 'message_delta', payload: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } } },
  { name: 'message_stop', payload: { type: 'message_stop' } },
]

describe('Anthropic /v1/messages honours the Provider Template wire shape', () => {
  let iroha: TestApp
  let csrf: string
  let upstream: ReturnType<typeof mockUpstreamTransport>

  beforeEach(async () => {
    upstream = mockUpstreamTransport()
    iroha = await createTestApp({ upstreamTransport: upstream.fetch })
    csrf = (await completeSetup(iroha)).csrf
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  const createProvider = async (fields: {
    displayName: string
    baseUrl: string
    templateId: string | null
    upstreamKey: string
  }): Promise<ConnectionBody> => {
    const payload: Record<string, unknown> = {
      handle: crypto.randomUUID(),
      displayName: fields.displayName,
      baseUrl: fields.baseUrl,
      keys: [{ upstreamKey: fields.upstreamKey }],
    }
    // Omit the field entirely for the template-less case so we exercise the
    // real "no Provider Template" create path.
    if (fields.templateId !== null) payload.templateId = fields.templateId
    const response = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      csrf,
    })
    if (response.status !== 201) {
      throw new Error(`Provider create failed with ${response.status}: ${await response.text()}`)
    }
    return (await response.json()) as ConnectionBody
  }

  const createKey = async (providerId: string): Promise<string> => {
    const response = await iroha.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'App credential', scope: [{ providerId }] }),
      csrf,
    })
    if (response.status !== 201) {
      throw new Error(`Key create failed with ${response.status}: ${await response.text()}`)
    }
    return ((await response.json()) as { secret: string }).secret
  }

  const messages = (handle: string, token: string, body: Record<string, unknown>) =>
    iroha.fetch(`/providers/${handle}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })

  /* ----- generic-anthropic-compatible: the regression ----- */

  test('generic-anthropic-compatible: forwards the Anthropic body verbatim to upstream /messages', async () => {
    upstream.respondWith(() => new Response(anthropicSuccessBody(), { status: 200 }))
    const provider = await createProvider({
      displayName: 'Anthropic proxy',
      baseUrl: GENERIC_ANTHROPIC_BASE_URL,
      templateId: 'generic-anthropic-compatible',
      upstreamKey: ANTHROPIC_UPSTREAM_KEY,
    })
    const secret = await createKey(provider.id)

    const body = anthropicMessageBody()
    await messages(provider.handle, secret, body)

    expect(upstream.calls).toHaveLength(1)
    const call = upstream.calls[0]!
    expect(call.url).toBe(`${GENERIC_ANTHROPIC_BASE_URL}/messages`)
    expect(call.method).toBe('POST')
    const sentBody = JSON.parse(call.body!) as Record<string, unknown>
    expect(sentBody).toEqual(body)
  })

  test('generic-anthropic-compatible: streaming Anthropic SSE events pass through, not synthesised', async () => {
    upstream.respondWith(() => sseResponse(anthropicStreamEvents.map((e) => anthropicEvent(e.name, e.payload))))
    const provider = await createProvider({
      displayName: 'Anthropic proxy',
      baseUrl: GENERIC_ANTHROPIC_BASE_URL,
      templateId: 'generic-anthropic-compatible',
      upstreamKey: ANTHROPIC_UPSTREAM_KEY,
    })
    const secret = await createKey(provider.id)

    const response = await messages(provider.handle, secret, anthropicMessageBody({ stream: true }))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    expect(upstream.calls).toHaveLength(1)
    expect(upstream.calls[0]!.url).toBe(`${GENERIC_ANTHROPIC_BASE_URL}/messages`)

    const streamBody = await response.text()
    // Passthrough carries the upstream's Anthropic frames verbatim, including
    // the `text_delta` shape that OpenAI-chunk synthesis would never produce.
    expect(streamBody).toContain('event: message_start')
    expect(streamBody).toContain('text_delta')
    expect(streamBody).toContain('event: message_stop')
  })

  /* ----- first-party anthropic: still passthrough ----- */

  test('anthropic (first-party): still forwards verbatim to upstream /messages', async () => {
    upstream.respondWith(() => new Response(anthropicSuccessBody(), { status: 200 }))
    const provider = await createProvider({
      displayName: 'Anthropic',
      baseUrl: FIRST_PARTY_ANTHROPIC_BASE_URL,
      templateId: 'anthropic',
      upstreamKey: ANTHROPIC_UPSTREAM_KEY,
    })
    const secret = await createKey(provider.id)

    const body = anthropicMessageBody()
    await messages(provider.handle, secret, body)

    expect(upstream.calls).toHaveLength(1)
    expect(upstream.calls[0]!.url).toBe(`${FIRST_PARTY_ANTHROPIC_BASE_URL}/messages`)
    expect(JSON.parse(upstream.calls[0]!.body!)).toEqual(body)
  })

  test('anthropic (first-party): streaming still passes Anthropic SSE frames through', async () => {
    upstream.respondWith(() => sseResponse(anthropicStreamEvents.map((e) => anthropicEvent(e.name, e.payload))))
    const provider = await createProvider({
      displayName: 'Anthropic',
      baseUrl: FIRST_PARTY_ANTHROPIC_BASE_URL,
      templateId: 'anthropic',
      upstreamKey: ANTHROPIC_UPSTREAM_KEY,
    })
    const secret = await createKey(provider.id)

    const response = await messages(provider.handle, secret, anthropicMessageBody({ stream: true }))
    expect(response.status).toBe(200)
    expect(upstream.calls[0]!.url).toBe(`${FIRST_PARTY_ANTHROPIC_BASE_URL}/messages`)
    expect(await response.text()).toContain('text_delta')
  })

  /* ----- openai-shaped: still translated ----- */

  test('openai: translates the Anthropic body to OpenAI shape and calls /chat/completions', async () => {
    upstream.respondWith(() => new Response(openAiCompletionBody(), { status: 200 }))
    const provider = await createProvider({
      displayName: 'OpenAI',
      baseUrl: OPENAI_BASE_URL,
      templateId: 'openai',
      upstreamKey: OPENAI_UPSTREAM_KEY,
    })
    const secret = await createKey(provider.id)

    const response = await messages(provider.handle, secret, anthropicMessageBody())
    expect(response.status).toBe(200)

    expect(upstream.calls).toHaveLength(1)
    const call = upstream.calls[0]!
    expect(call.url).toBe(`${OPENAI_BASE_URL}/chat/completions`)
    const sent = JSON.parse(call.body!) as Record<string, unknown>
    expect(sent.messages).toEqual([{ role: 'user', content: 'Hello' }])

    // The caller still receives an Anthropic-shape answer.
    const answer = (await response.json()) as Record<string, unknown>
    expect(answer.type).toBe('message')
    expect(answer.content).toEqual([{ type: 'text', text: 'Hello from OpenAI' }])
  })

  test('openai: an upstream error still returns an Anthropic-shape error envelope', async () => {
    const responder: UpstreamResponder = () =>
      new Response(
        JSON.stringify({
          error: {
            message: 'Incorrect API key provided',
            type: 'invalid_request_error',
            code: 'invalid_api_key',
          },
        }),
        { status: 401 },
      )
    upstream.respondWith(responder)
    const provider = await createProvider({
      displayName: 'OpenAI',
      baseUrl: OPENAI_BASE_URL,
      templateId: 'openai',
      upstreamKey: OPENAI_UPSTREAM_KEY,
    })
    const secret = await createKey(provider.id)

    const response = await messages(provider.handle, secret, anthropicMessageBody())
    expect(response.status).toBe(401)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.type).toBe('error')
    expect((body.error as Record<string, unknown>).type).toBe('authentication_error')
  })

  /* ----- no template: treated as OpenAI shape ----- */

  // The create API always seeds an omitted templateId with the Generic
  // OpenAI-compatible Template, so a genuinely template-less (null) Provider
  // cannot be made through the endpoint. Per the ticket, assert the null path
  // against a Provider whose templateId is null directly in the DB: create one
  // normally, then re-seat its row and key with templateId cleared. Reusing the
  // already-encrypted key blob keeps it decryptable by the same cipher.
  const makeTemplatelessProvider = async (baseUrl: string, upstreamKey: string): Promise<ConnectionBody> => {
    const seed = await createProvider({
      displayName: 'Bring your own',
      baseUrl,
      templateId: 'openai',
      upstreamKey,
    })
    const record = await iroha.database.providers.getProvider(seed.id)
    if (record === null) throw new Error('seed provider vanished')
    const keys = await iroha.database.providers.listKeys(seed.id)
    // Deleting the Provider cascades its keys; re-insert both with templateId null.
    await iroha.database.providers.deleteProvider(seed.id)
    await iroha.database.providers.insertProvider({ ...record, templateId: null })
    for (const key of keys) await iroha.database.providers.insertKey(key)
    return seed
  }

  test('no Provider Template: reaches the surface and is treated as the OpenAI shape (translated)', async () => {
    upstream.respondWith(() => new Response(openAiCompletionBody(), { status: 200 }))
    const provider = await makeTemplatelessProvider(NO_TEMPLATE_BASE_URL, OPENAI_UPSTREAM_KEY)

    const stored = await iroha.database.providers.getProvider(provider.id)
    expect(stored?.templateId).toBeNull()

    const secret = await createKey(provider.id)
    const response = await messages(provider.handle, secret, anthropicMessageBody())
    expect(response.status).toBe(200)

    expect(upstream.calls).toHaveLength(1)
    // OpenAI shape => translated => /chat/completions, never /messages.
    expect(upstream.calls[0]!.url).toBe(`${NO_TEMPLATE_BASE_URL}/chat/completions`)
    const answer = (await response.json()) as Record<string, unknown>
    expect(answer.type).toBe('message')
  })
})
