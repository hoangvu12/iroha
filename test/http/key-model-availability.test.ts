/**
 * Key Model Availability on a key-scoped Provider (ADR-0023).
 *
 * The fixture reproduces the shape measured on a real DashScope Provider: the
 * Upstream Keys answer `GET /models` with different lists, and the lists are
 * not nested — each key carries something the other does not. Every assertion
 * here is about which key a Request reaches, not about what the upstream said.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { completeSetup, createTestApp, type TestApp } from '../support/app.ts'
import { mockUpstreamTransport, type RecordedUpstreamCall } from '../support/inference.ts'

const BASE_URL = 'https://api.example.com/v1'
const SHARED_MODEL = 'qwen3.7-plus'
const WIDE_ONLY_MODEL = 'deepseek-v3.2'
const NARROW_ONLY_MODEL = 'glm-5'
const WIDE_KEY = 'sk-wide-entitlement-key'
const NARROW_KEY = 'sk-narrow-entitlement-key'

const CATALOGS: Record<string, readonly string[]> = {
  [`Bearer ${WIDE_KEY}`]: [SHARED_MODEL, WIDE_ONLY_MODEL],
  [`Bearer ${NARROW_KEY}`]: [SHARED_MODEL, NARROW_ONLY_MODEL],
}

describe('Key Model Availability', () => {
  let iroha: TestApp
  let upstream: ReturnType<typeof mockUpstreamTransport>
  let csrf: string
  let providerId: string
  let providerHandle: string
  let secret: string
  /** Set true to make every `GET /models` fail, leaving the stored lists behind. */
  let discoveryBroken = false

  const isDiscovery = (call: RecordedUpstreamCall): boolean => call.url.endsWith('/models')

  const completion = () =>
    Response.json({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: SHARED_MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })

  beforeEach(async () => {
    discoveryBroken = false
    upstream = mockUpstreamTransport()
    upstream.respondWith((call) => {
      if (!isDiscovery(call)) return completion()
      if (discoveryBroken) return new Response('upstream is unwell', { status: 500 })
      const models = CATALOGS[call.headers.authorization ?? '']
      // A key this fixture does not describe gets a failed discovery, which is
      // how a key ends up with *unknown* availability. Answering with an empty
      // list would instead be a successful discovery of nothing.
      if (models === undefined) return new Response('no catalog for this key', { status: 500 })
      return Response.json({ object: 'list', data: models.map((id) => ({ id, object: 'model' })) })
    })

    iroha = await createTestApp({ upstreamTransport: upstream.fetch })
    csrf = (await completeSetup(iroha)).csrf

    // The DashScope template is the built-in Pack that declares its Upstream
    // Models key-scoped, so this Provider's keys each get their own list.
    const created = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle: crypto.randomUUID(),
        templateId: 'dashscope',
        displayName: 'Entitlement tiers',
        baseUrl: BASE_URL,
        keys: [{ upstreamKey: WIDE_KEY }],
      }),
      csrf,
    })
    const provider = (await created.json()) as { id: string; handle: string }
    providerId = provider.id
    providerHandle = provider.handle

    await iroha.fetch(`/api/v1/admin/providers/${providerId}/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upstreamKey: NARROW_KEY }),
      csrf,
    })
    await iroha.fetch(`/api/v1/admin/providers/${providerId}/catalog/refresh`, { method: 'POST', csrf })

    const key = await iroha.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'App', scope: [{ providerId }] }),
      csrf,
    })
    secret = ((await key.json()) as { secret: string }).secret
    upstream.reset()
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  const chat = (model: string) =>
    iroha.fetch(`/providers/${providerHandle}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Hello' }] }),
    })

  /** The authorization headers of the inference Attempts, discovery excluded. */
  const attemptKeys = (): string[] =>
    upstream.calls.filter((call) => !isDiscovery(call)).map((call) => call.headers.authorization ?? '')

  const storedAvailability = async () =>
    await iroha.database.keyModelAvailability.listForProvider(providerId)

  const disableKey = async (keyId: string) => {
    const response = await iroha.fetch(
      `/api/v1/admin/providers/${providerId}/keys/${keyId}/disable`,
      { method: 'POST', csrf },
    )
    if (response.status !== 200) throw new Error(`Disable failed with ${response.status}`)
  }

  test('discovers a separate model list for every Upstream Key', async () => {
    const stored = await storedAvailability()
    const lists = stored.map((entry) => [...entry.models].sort())

    expect(stored).toHaveLength(2)
    expect(lists).toContainEqual([SHARED_MODEL, WIDE_ONLY_MODEL].sort())
    expect(lists).toContainEqual([SHARED_MODEL, NARROW_ONLY_MODEL].sort())
    expect(stored.every((entry) => !entry.stale)).toBe(true)
  })

  test('the Model Catalog is the union across keys, not one key list', async () => {
    const response = await iroha.fetch(`/api/v1/admin/providers/${providerId}/catalog`, { csrf })
    const body = (await response.json()) as { entries: { modelId: string }[] }
    const listed = body.entries.map((entry) => entry.modelId)

    // A model only one key carries stays askable; neither key sees both.
    expect(listed).toContain(WIDE_ONLY_MODEL)
    expect(listed).toContain(NARROW_ONLY_MODEL)
  })

  test('routes a partly available model only to the keys that carry it', async () => {
    for (let index = 0; index < 4; index++) {
      expect((await chat(WIDE_ONLY_MODEL)).status).toBe(200)
    }

    // Four Requests, one key: rotation never reached the key that lacks it.
    expect(attemptKeys()).toEqual(Array.from({ length: 4 }, () => `Bearer ${WIDE_KEY}`))
  })

  test('still rotates over both keys for a model they both carry', async () => {
    for (let index = 0; index < 4; index++) {
      expect((await chat(SHARED_MODEL)).status).toBe(200)
    }

    expect(new Set(attemptKeys())).toEqual(new Set([`Bearer ${WIDE_KEY}`, `Bearer ${NARROW_KEY}`]))
  })

  test('refuses a model no key carries without sending an Attempt', async () => {
    const response = await chat('qwen3.7-pluss-typo')

    expect(response.status).toBe(404)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('model_unroutable')
    expect(body.error.message).toContain('qwen3.7-pluss-typo')
    // Refused before routing: no upstream call was made at all.
    expect(attemptKeys()).toHaveLength(0)
  })

  test('a carrier being unavailable does not refuse while another key is still eligible', async () => {
    // Availability orders keys, it never removes them. With the only carrier
    // disabled the remaining key is still tried — the Provider may serve a
    // model its own catalog under-reports, and refusing here would retire real
    // capacity on nothing more than an absence.
    const stored = await storedAvailability()
    const carrier = stored.find((entry) => entry.models.includes(WIDE_ONLY_MODEL))
    expect(carrier).toBeDefined()
    await disableKey(carrier?.keyId ?? '')

    const response = await chat(WIDE_ONLY_MODEL)

    expect(response.status).toBe(200)
    expect(attemptKeys()).toEqual([`Bearer ${NARROW_KEY}`])
  })

  test('reports carriers that are all unavailable as temporary, not as a credentials problem', async () => {
    // Now nothing is eligible at all, while a key that carries the model still
    // exists. That is a wait-and-retry answer, not "your credentials are gone".
    for (const entry of await storedAvailability()) await disableKey(entry.keyId)

    const response = await chat(WIDE_ONLY_MODEL)

    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('model_keys_unavailable')
  })

  test('a key with no discovered availability is unrestricted, never excluded', async () => {
    // This key's discovery fails, so it has no list of its own. It must remain
    // a candidate, or an undiscovered key would be dead weight.
    await iroha.fetch(`/api/v1/admin/providers/${providerId}/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upstreamKey: 'sk-key-the-provider-will-not-describe' }),
      csrf,
    })
    expect(await storedAvailability()).toHaveLength(2)
    upstream.reset()

    // With one availability unknown, a model absent from every *known* list is
    // no longer provably unroutable, so it is attempted rather than refused.
    // No key is preferred for it, so the whole eligible pool rotates as usual.
    const response = await chat('a-model-no-known-list-carries')

    expect(response.status).toBe(200)
    expect(attemptKeys()).toHaveLength(1)
  })

  test('a failed rediscovery keeps the previous list and marks it stale', async () => {
    discoveryBroken = true

    await iroha.fetch(`/api/v1/admin/providers/${providerId}/catalog/refresh`, { method: 'POST', csrf })

    const stored = await storedAvailability()
    expect(stored).toHaveLength(2)
    expect(stored.every((entry) => entry.stale)).toBe(true)
    // The models survive: a previous answer still beats no answer.
    expect(stored.flatMap((entry) => [...entry.models]).sort()).toEqual(
      [SHARED_MODEL, SHARED_MODEL, WIDE_ONLY_MODEL, NARROW_ONLY_MODEL].sort(),
    )
  })
})
