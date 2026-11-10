/**
 * An explicit per-Key model allow-list outranks a discovered Key Model
 * Availability (ADR-0023).
 *
 * The shape here is what the measured relay population produces: a Provider
 * whose Owner curates the model list by hand, one shared model id per model,
 * and each Upstream Key naming the upstream's own spelling for it (ADR-0028).
 * The upstream advertises its catalogue in *its* id space, so a discovered
 * list never names the gateway's id — and a discovered list that outranks the
 * Owner's list leaves the Provider unable to route anything it can serve.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { completeSetup, createTestApp, type TestApp } from '../support/app.ts'
import { mockUpstreamTransport, type RecordedUpstreamCall } from '../support/inference.ts'

const BASE_URL = 'https://relay.example.com/v1'
/** The gateway's shared id for one model. */
const CANONICAL = 'claude-opus-5.5'
/** The spelling the upstream actually answers. */
const UPSTREAM_ID = 'claude/claude-opus-5-5'
/** A model the upstream advertises but the Owner did not put on the list. */
const ADVERTISED_ONLY = 'claude-opus-4.8'

describe('An explicit per-Key model allow-list', () => {
  let iroha: TestApp
  let upstream: ReturnType<typeof mockUpstreamTransport>
  let csrf: string
  let providerId: string
  let providerHandle: string
  let secret: string

  const isDiscovery = (call: RecordedUpstreamCall): boolean => call.url.endsWith('/models')

  const completion = () =>
    Response.json({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: UPSTREAM_ID,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })

  beforeEach(async () => {
    upstream = mockUpstreamTransport()
    upstream.respondWith((call) => {
      if (!isDiscovery(call)) return completion()
      // The upstream advertises its own id space. The shared id the gateway
      // uses is not in it, and neither is anything the Owner did not list.
      return Response.json({
        object: 'list',
        data: [UPSTREAM_ID, ADVERTISED_ONLY].map((id) => ({ id, object: 'model' })),
      })
    })

    iroha = await createTestApp({ upstreamTransport: upstream.fetch })
    csrf = (await completeSetup(iroha)).csrf

    const created = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle: crypto.randomUUID(),
        displayName: 'Curated relay',
        baseUrl: BASE_URL,
        modelDiscovery: 'unsupported',
        requiresUpstreamKey: false,
        keys: [{ upstreamKey: '', baseUrl: BASE_URL }],
      }),
      csrf,
    })
    const provider = (await created.json()) as { id: string; handle: string; keys: { id: string }[] }
    providerId = provider.id
    providerHandle = provider.handle

    // The Owner's list and the per-Key rewrite, set the way the Owner sets them.
    const patchKey = async (keyId: string) => {
      const patched = await iroha.fetch(`/api/v1/admin/providers/${providerId}/keys/${keyId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          allowedModels: [CANONICAL],
          modelRewrites: { [CANONICAL]: UPSTREAM_ID },
        }),
        csrf,
      })
      expect(patched.status).toBe(200)
    }
    await patchKey(provider.keys[0]!.id)

    // A second Key, added the way a Key is added after the Provider exists.
    // Adding a Key is what runs discovery, so this is where a discovered
    // availability would be written for a Key that already carries the Owner's
    // own list.
    const added = await iroha.fetch(`/api/v1/admin/providers/${providerId}/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        upstreamKey: '',
        baseUrl: BASE_URL,
        allowedModels: [CANONICAL],
        modelRewrites: { [CANONICAL]: UPSTREAM_ID },
      }),
      csrf,
    })
    expect(added.status).toBe(201)

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

  const attemptModels = (): string[] =>
    upstream.calls
      .filter((call) => !isDiscovery(call))
      .map((call) => (call.body === null ? '' : (JSON.parse(call.body) as { model: string }).model))

  test('a curated model routes even though no discovered list names it', async () => {
    // The upstream's catalogue never contains the gateway's shared id, so a
    // discovered list cannot carry it. The Owner's list must.
    const response = await chat(CANONICAL)

    expect(response.status).toBe(200)
    expect(attemptModels()).toEqual([UPSTREAM_ID])
  })

  test('a model the Owner did not list is refused', async () => {
    // The upstream advertises it; the Owner's list does not. The list wins.
    const response = await chat(ADVERTISED_ONLY)

    expect(response.status).toBe(404)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('model_unroutable')
    expect(attemptModels()).toHaveLength(0)
  })

  test('a curated key is given no discovered availability of its own', async () => {
    // The Owner's list already says what the Key serves. A second, discovered
    // answer would put the upstream's advertised ids into the Model Catalog.
    const stored = await iroha.database.keyModelAvailability.listForProvider(providerId)

    expect(stored).toHaveLength(0)
  })

  test('the Model Catalog holds no discovered row from the upstream advertisement', async () => {
    const view = await iroha.fetch(`/api/v1/admin/providers/${providerId}/catalog`)
    const catalog = (await view.json()) as { entries: { modelId: string; source: string }[] }

    // The upstream advertised two ids. The Owner's list is the catalogue; the
    // advertisement must not appear, and nothing may be marked discovered.
    expect(catalog.entries.map((entry) => entry.modelId)).not.toContain(ADVERTISED_ONLY)
    expect(catalog.entries.filter((entry) => entry.source === 'discovered')).toEqual([])
  })
})
