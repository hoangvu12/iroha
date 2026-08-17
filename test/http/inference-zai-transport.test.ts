/**
 * Ticket 01 — Stop Z.ai tests reaching the real network.
 *
 * The assembled-app harness builds each typed Inference Adapter with the
 * test's stub upstream transport and hands them to the Adapter Registry. The
 * Z.ai adapter was missing from that list, so any assembled test exercising a
 * Z.ai Provider Connection escaped to the runtime's own `fetch` and reached
 * the real network. These tests pin the fix: every typed template drives
 * inference through the injected mock transport and never off-box.
 *
 * Fetch-spy substitution: outbound network is NOT disabled in this
 * environment, so we cannot prove "no real network" by pulling the plug.
 * Instead we substitute a fetch spy — the {@link mockUpstreamTransport} is the
 * only transport the assembled app is ever given, and every upstream call must
 * be recorded by it. An unexpected real-network call would bypass the spy and
 * leave `upstream.calls` short, failing the assertion.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { completeSetup, createTestApp, type TestApp } from '../support/app.ts'
import { mockUpstreamTransport, type UpstreamResponder } from '../support/inference.ts'

const ZAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
const ZAI_UPSTREAM_KEY = 'zai-upstream-secret-value-for-tests'

interface ConnectionBody {
  id: string
  handle: string
  displayName: string
  templateId: string | null
}

/** Answers a Chat Completions or an Anthropic Messages call with a valid body. */
const compatibleResponder: UpstreamResponder = (call) => {
  if (call.url.endsWith('/messages')) {
    return new Response(
      JSON.stringify({
        id: 'msg_01FromMockUpstream',
        type: 'message',
        role: 'assistant',
        model: 'mock-model',
        content: [{ type: 'text', text: 'Mock upstream reply' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 5 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  return Response.json(
    {
      id: 'chatcmpl-mock-upstream',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'mock-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Mock upstream reply' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    },
    { status: 200 },
  )
}

describe('typed Inference Adapters record against the injected mock transport', () => {
  let iroha: TestApp
  let csrf: string
  let upstream: ReturnType<typeof mockUpstreamTransport>

  beforeEach(async () => {
    // The mock transport is the ONLY transport the assembled app is given, so
    // any real-network escape would fail the "call was recorded" assertions.
    upstream = mockUpstreamTransport(compatibleResponder)
    iroha = await createTestApp({ upstreamTransport: upstream.fetch })
    csrf = (await completeSetup(iroha)).csrf
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  const createConnection = async (
    fields: Record<string, unknown>,
  ): Promise<ConnectionBody> => {
    const response = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: crypto.randomUUID(), ...fields }),
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

  const chat = (handle: string, token: string, model: string) =>
    iroha.fetch(`/providers/${handle}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Say hello' }],
      }),
    })

  test('a Z.ai Provider drives inference through the stub transport, not the real network', async () => {
    const connection = await createConnection({
      displayName: 'Z.ai',
      baseUrl: ZAI_BASE_URL,
      templateId: 'zai',
      keys: [{ upstreamKey: ZAI_UPSTREAM_KEY }],
    })
    const { secret } = await createKey([{ providerId: connection.id }])

    const response = await chat(connection.handle, secret, 'glm-4.6')

    expect(response.status).toBe(200)
    // The call was recorded by the injected mock transport — it did NOT escape
    // to the real network.
    expect(upstream.calls).toHaveLength(1)
    const call = upstream.calls[0]!
    expect(call.url).toBe(`${ZAI_BASE_URL}/chat/completions`)
    expect(call.method).toBe('POST')
    // The Z.ai upstream key was injected server-side; the request reached the
    // Provider seam rather than the live upstream.
    expect(call.headers['authorization']).toBe(`Bearer ${ZAI_UPSTREAM_KEY}`)
  })

  // The guard: every built-in typed template must reach the injected mock
  // transport. If the harness ever constructs one of these adapters without
  // the stub transport (as it previously did for Z.ai), that template's
  // request would escape to the real network and record nothing here, failing
  // the assertion. Ticket 05 makes this structural; this is the concrete guard.
  const typedTemplates: ReadonlyArray<{
    readonly name: string
    readonly templateId: string
    readonly baseUrl: string
    readonly model: string
  }> = [
    { name: 'generic (openai)', templateId: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { name: 'anthropic', templateId: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4' },
    { name: 'dashscope', templateId: 'dashscope', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen-max' },
    { name: 'minimax', templateId: 'MiniMax', baseUrl: 'https://api.minimax.io/v1', model: 'MiniMax-M2' },
    { name: 'zai', templateId: 'zai', baseUrl: ZAI_BASE_URL, model: 'glm-4.6' },
  ]

  for (const template of typedTemplates) {
    test(`typed template ${template.name} records its upstream call against the stub transport`, async () => {
      const connection = await createConnection({
        displayName: template.name,
        baseUrl: template.baseUrl,
        templateId: template.templateId,
        keys: [{ upstreamKey: `${template.templateId}-upstream-secret-value-for-tests` }],
      })
      const { secret } = await createKey([{ providerId: connection.id }])

      await chat(connection.handle, secret, template.model)

      // The upstream call was recorded by the injected mock transport, proving
      // the typed adapter is wired to the stub and never touched the real
      // network.
      expect(upstream.calls.length).toBeGreaterThanOrEqual(1)
      expect(upstream.calls.every((call) => call.url.startsWith(template.baseUrl))).toBe(true)
    })
  }
})
