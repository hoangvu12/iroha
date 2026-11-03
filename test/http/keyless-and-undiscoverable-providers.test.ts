import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  completeSetup,
  createTestApp,
  fakeKeyProbe,
  type FakeKeyProbe,
  type TestApp,
} from '../support/app.ts'
import { mockUpstreamTransport } from '../support/inference.ts'

const UPSTREAM_KEY = 'sk-upstream-secret-value-for-tests'
const BASE_URL = 'https://api.example.com/v1'
const BASE = '/api/v1/admin/providers'
const MODEL = 'gpt-6.1-sol'

interface KeyBody {
  id: string
  health: string
  healthReason: string | null
  lastProbe: { verdict: string; reason: string | null } | null
}

interface ProviderBody {
  id: string
  handle: string
  requiresUpstreamKey: boolean
  modelDiscovery: string | null
  keys: KeyBody[]
}

describe('Providers that need no key or expose no model list', () => {
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

  const create = (fields: Record<string, unknown>) =>
    iroha.fetch(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle: crypto.randomUUID(),
        displayName: 'Gateway',
        baseUrl: BASE_URL,
        ...fields,
      }),
      csrf,
    })

  const created = async (fields: Record<string, unknown>): Promise<ProviderBody> => {
    const response = await create(fields)
    if (response.status !== 201) {
      throw new Error(`Create failed with ${response.status}: ${await response.text()}`)
    }
    return (await response.json()) as ProviderBody
  }

  const chat = async (provider: ProviderBody) => {
    const keyResponse = await iroha.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'App', scope: [{ providerId: provider.id }] }),
      csrf,
    })
    const { secret } = (await keyResponse.json()) as { secret: string }
    upstream.reset()
    return await iroha.fetch(`/providers/${provider.handle}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hello' }] }),
    })
  }

  describe('a Provider that needs no key', () => {
    test('is created without keys and seeds one empty-secret key', async () => {
      const provider = await created({ requiresUpstreamKey: false })

      expect(provider.requiresUpstreamKey).toBe(false)
      expect(provider.keys).toHaveLength(1)
      expect(probe.calls.map((call) => call.upstreamKey)).toEqual([''])
    })

    test('sends no authentication header upstream', async () => {
      const provider = await created({ requiresUpstreamKey: false })

      const response = await chat(provider)

      expect(response.status).toBe(200)
      expect(upstream.calls).toHaveLength(1)
      expect(upstream.calls[0]!.headers['authorization']).toBeUndefined()
    })

    test('accepts an added key with no secret', async () => {
      const provider = await created({ requiresUpstreamKey: false })

      const response = await iroha.fetch(`${BASE}/${provider.id}/keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl: 'https://mirror.example.com/v1' }),
        csrf,
      })

      expect(response.status).toBe(201)
      expect(((await response.json()) as ProviderBody).keys).toHaveLength(2)
    })

    test('gains the key it routes through when switched to need none', async () => {
      const provider = await created({ keys: [{ upstreamKey: UPSTREAM_KEY }] })
      await iroha.fetch(`${BASE}/${provider.id}/keys/${provider.keys[0]!.id}`, { method: 'DELETE', csrf })

      const response = await iroha.fetch(`${BASE}/${provider.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requiresUpstreamKey: false }),
        csrf,
      })
      const switched = (await response.json()) as ProviderBody

      expect(switched.keys).toHaveLength(1)
      expect(switched.keys[0]!.health).toBe('active')
      expect((await chat(switched)).status).toBe(200)
      expect(upstream.calls[0]!.headers['authorization']).toBeUndefined()
    })

    test('keeps the last key it routes through', async () => {
      const provider = await created({ requiresUpstreamKey: false })

      const response = await iroha.fetch(`${BASE}/${provider.id}/keys/${provider.keys[0]!.id}`, {
        method: 'DELETE',
        csrf,
      })

      expect(response.status).toBe(400)
      const after = (await (await iroha.fetch(`${BASE}/${provider.id}`)).json()) as ProviderBody
      expect(after.keys).toHaveLength(1)
    })

    test('a Provider that needs a key still refuses an empty one', async () => {
      const response = await create({ keys: [{ upstreamKey: '' }] })

      expect(response.status).toBe(400)
    })

    test('a keyed Provider still sends its key', async () => {
      const provider = await created({ keys: [{ upstreamKey: UPSTREAM_KEY }] })

      await chat(provider)

      expect(upstream.calls[0]!.headers['authorization']).toBe(`Bearer ${UPSTREAM_KEY}`)
    })
  })

  describe('a Provider whose model discovery is off', () => {
    test('trusts its keys without the models key test', async () => {
      probe.respondWith({ verdict: 'rejected', reason: 'the provider rejected the key (HTTP 401)' })

      const provider = await created({
        keys: [{ upstreamKey: UPSTREAM_KEY }],
        modelDiscovery: 'unsupported',
      })

      expect(provider.modelDiscovery).toBe('unsupported')
      expect(probe.calls).toHaveLength(0)
      expect(provider.keys[0]!.health).toBe('active')
    })

    test('serves a model the Owner added by hand', async () => {
      const provider = await created({
        keys: [{ upstreamKey: UPSTREAM_KEY }],
        modelDiscovery: 'unsupported',
      })
      const added = await iroha.fetch(`${BASE}/${provider.id}/catalog/models`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modelId: MODEL }),
        csrf,
      })
      expect(added.status).toBe(200)

      const response = await chat(provider)

      expect(response.status).toBe(200)
      expect(upstream.calls[0]!.url).toBe(`${BASE_URL}/chat/completions`)
    })

    test('never reads GET /models on refresh', async () => {
      const provider = await created({
        keys: [{ upstreamKey: UPSTREAM_KEY }],
        modelDiscovery: 'unsupported',
      })
      upstream.reset()

      const response = await iroha.fetch(`${BASE}/${provider.id}/catalog/refresh`, {
        method: 'POST',
        csrf,
      })

      expect(response.status).toBe(200)
      expect(upstream.calls.filter((call) => call.url.endsWith('/models'))).toHaveLength(0)
    })

    test('a manual key test explains itself without changing health', async () => {
      const provider = await created({
        keys: [{ upstreamKey: UPSTREAM_KEY }],
        modelDiscovery: 'unsupported',
      })
      const keyId = provider.keys[0]!.id

      const response = await iroha.fetch(`${BASE}/${provider.id}/keys/${keyId}/test`, {
        method: 'POST',
        csrf,
      })
      const key = ((await response.json()) as ProviderBody).keys[0]!

      expect(response.status).toBe(200)
      expect(probe.calls).toHaveLength(0)
      expect(key.health).toBe('active')
      expect(key.lastProbe?.verdict).toBe('inconclusive')
      expect(key.lastProbe?.reason).toContain('model discovery is off')
    })

    test('trusts again a key that only the models key test rejected', async () => {
      probe.respondWith({ verdict: 'rejected', reason: 'the provider rejected the key (HTTP 401)' })
      const provider = await created({ keys: [{ upstreamKey: UPSTREAM_KEY }] })
      expect(provider.keys[0]!.health).toBe('invalid_authentication')

      const response = await iroha.fetch(`${BASE}/${provider.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modelDiscovery: 'unsupported' }),
        csrf,
      })

      expect(((await response.json()) as ProviderBody).keys[0]!.health).toBe('active')
    })

    test('a manual key test trusts a demoted key again', async () => {
      const provider = await created({
        keys: [{ upstreamKey: UPSTREAM_KEY }],
        modelDiscovery: 'unsupported',
      })
      const keyId = provider.keys[0]!.id
      const at = iroha.clock.now()
      await iroha.database.providers.updateKey(
        keyId,
        { health: 'invalid_authentication', healthReason: 'upstream refused', healthChangedAt: at },
        at,
      )

      const response = await iroha.fetch(`${BASE}/${provider.id}/keys/${keyId}/test`, {
        method: 'POST',
        csrf,
      })

      expect(((await response.json()) as ProviderBody).keys[0]!.health).toBe('active')
    })

    test('can be switched on and off, and back to the template default', async () => {
      const provider = await created({ keys: [{ upstreamKey: UPSTREAM_KEY }] })
      expect(provider.modelDiscovery).toBeNull()

      const patch = (modelDiscovery: unknown) =>
        iroha.fetch(`${BASE}/${provider.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ modelDiscovery }),
          csrf,
        })

      expect(((await (await patch('unsupported')).json()) as ProviderBody).modelDiscovery).toBe('unsupported')
      expect(((await (await patch(null)).json()) as ProviderBody).modelDiscovery).toBeNull()
      expect((await patch('sometimes')).status).toBe(400)
    })
  })
})
