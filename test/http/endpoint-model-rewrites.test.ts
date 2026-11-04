import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  completeSetup,
  createTestApp,
  fakeKeyProbe,
  type FakeKeyProbe,
  type TestApp,
} from '../support/app.ts'
import { mockUpstreamTransport } from '../support/inference.ts'

const BASE = '/api/v1/admin/providers'
const BASE_URL = 'https://api.example.com/v1'
const MIRROR_URL = 'https://mirror.example.com/v1'
const MODEL = 'gpt-6.1-sol'

interface KeyBody {
  id: string
  baseUrl: string | null
  modelRewrites: Record<string, string> | null
}

interface ProviderBody {
  id: string
  handle: string
  keys: KeyBody[]
}

/**
 * Per-endpoint model rewrites: one Provider whose endpoints each address the
 * same gateway-facing model under a different native ID. The rewrite is applied
 * to the endpoint the request lands on, and a view round-trips the map.
 */
describe('per-endpoint model rewrites', () => {
  let iroha: TestApp
  let probe: FakeKeyProbe
  let upstream: ReturnType<typeof mockUpstreamTransport>
  let csrf: string

  beforeEach(async () => {
    probe = fakeKeyProbe()
    upstream = mockUpstreamTransport()
    iroha = await createTestApp({ upstreamKeyProbe: probe, upstreamTransport: upstream.fetch })
    csrf = (await completeSetup(iroha)).csrf
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  const created = async (fields: Record<string, unknown>): Promise<ProviderBody> => {
    const response = await iroha.fetch(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle: crypto.randomUUID(),
        displayName: 'Gateway',
        baseUrl: BASE_URL,
        modelDiscovery: 'unsupported',
        ...fields,
      }),
      csrf,
    })
    if (response.status !== 201) {
      throw new Error(`Create failed with ${response.status}: ${await response.text()}`)
    }
    const provider = (await response.json()) as ProviderBody
    const added = await iroha.fetch(`${BASE}/${provider.id}/catalog/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: MODEL }),
      csrf,
    })
    if (added.status !== 200) throw new Error(`Add model failed: ${await added.text()}`)
    return provider
  }

  const chat = async (provider: ProviderBody) => {
    const keyResponse = await iroha.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'App', scope: [{ providerId: provider.id }] }),
      csrf,
    })
    const { secret } = (await keyResponse.json()) as { secret: string }
    return await iroha.fetch(`/providers/${provider.handle}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hello' }] }),
    })
  }

  const sentModel = (url: string): string | undefined => {
    const call = upstream.calls.find((c) => c.url.startsWith(url))
    if (call?.body == null) return undefined
    return (JSON.parse(call.body) as { model?: string }).model
  }

  test('sends the native ID an endpoint maps the requested model to', async () => {
    const provider = await created({
      requiresUpstreamKey: false,
      keys: [{ baseUrl: '', modelRewrites: { [MODEL]: 'openai/gpt-6.1-sol' } }],
    })
    expect(provider.keys[0]!.modelRewrites).toEqual({ [MODEL]: 'openai/gpt-6.1-sol' })

    upstream.reset()
    const response = await chat(provider)

    expect(response.status).toBe(200)
    expect(sentModel(BASE_URL)).toBe('openai/gpt-6.1-sol')
  })

  test('sends the requested ID unchanged when the endpoint has no rewrite for it', async () => {
    const provider = await created({
      requiresUpstreamKey: false,
      keys: [{ baseUrl: '', modelRewrites: { 'other-model': 'x/other' } }],
    })

    upstream.reset()
    await chat(provider)

    expect(sentModel(BASE_URL)).toBe(MODEL)
  })

  test('maps per endpoint: each endpoint receives its own native ID', async () => {
    const provider = await created({
      requiresUpstreamKey: false,
      keys: [
        { baseUrl: '', modelRewrites: { [MODEL]: 'native/default' } },
        { baseUrl: MIRROR_URL, modelRewrites: { [MODEL]: 'native/mirror' } },
      ],
    })

    upstream.reset()
    // Two requests cover both endpoints under round-robin regardless of order.
    await chat(provider)
    await chat(provider)

    expect(sentModel(BASE_URL)).toBe('native/default')
    expect(sentModel(MIRROR_URL)).toBe('native/mirror')
  })

  test('PATCH sets and the view round-trips the rewrite map', async () => {
    const provider = await created({
      requiresUpstreamKey: false,
      keys: [{ baseUrl: '' }],
    })
    expect(provider.keys[0]!.modelRewrites).toBeNull()

    const response = await iroha.fetch(`${BASE}/${provider.id}/keys/${provider.keys[0]!.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelRewrites: { [MODEL]: 'openai/gpt-6.1-sol' } }),
      csrf,
    })

    expect(response.status).toBe(200)
    const after = (await response.json()) as ProviderBody
    expect(after.keys[0]!.modelRewrites).toEqual({ [MODEL]: 'openai/gpt-6.1-sol' })
  })

  test('PATCH with an empty map clears the rewrites to null', async () => {
    const provider = await created({
      requiresUpstreamKey: false,
      keys: [{ baseUrl: '', modelRewrites: { [MODEL]: 'openai/gpt-6.1-sol' } }],
    })

    const response = await iroha.fetch(`${BASE}/${provider.id}/keys/${provider.keys[0]!.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelRewrites: {} }),
      csrf,
    })

    expect(response.status).toBe(200)
    expect(((await response.json()) as ProviderBody).keys[0]!.modelRewrites).toBeNull()
  })

  test('rejects a rewrite map whose values are not strings', async () => {
    const provider = await created({ requiresUpstreamKey: false, keys: [{ baseUrl: '' }] })

    const response = await iroha.fetch(`${BASE}/${provider.id}/keys/${provider.keys[0]!.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelRewrites: { [MODEL]: 123 } }),
      csrf,
    })

    expect(response.status).toBe(400)
    const failure = (await response.json()) as { error: { problems: { field: string }[] } }
    expect(failure.error.problems.map((p) => p.field)).toEqual(['modelRewrites'])
  })
})
