import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  completeSetup,
  createTestApp,
  type TestApp,
} from '../support/app.ts'
import { mockUpstreamTransport } from '../support/inference.ts'

const UPSTREAM_KEY = 'sk-upstream-secret-value-for-tests'
const BASE_URL = 'https://api.example.com/v1'
const MODEL = 'gpt-4o-mini'

interface ConnectionBody {
  id: string
  handle: string
  displayName: string
  keys: { id: string; health: string }[]
}

/** The canonical OpenAI-shaped model discovery answer. */
function discoveryBody(modelIds: string[]): Response {
  return Response.json({
    object: 'list',
    data: modelIds.map((id, index) => ({ id, object: 'model', created: 1_700_000_000 + index })),
  })
}

describe('the provider-scoped Models API', () => {
  let iroha: TestApp
  let csrf: string
  let upstream: ReturnType<typeof mockUpstreamTransport>
  let connection: ConnectionBody

  beforeEach(async () => {
    upstream = mockUpstreamTransport(() => discoveryBody([MODEL, 'gpt-4o']))
    iroha = await createTestApp({ upstreamTransport: upstream.fetch })
    csrf = (await completeSetup(iroha)).csrf
    connection = await createConnection()
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  const createConnection = async (): Promise<ConnectionBody> => {
    const response = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle: crypto.randomUUID(),
        displayName: 'Catalog example',
        baseUrl: BASE_URL,
        keys: [{ upstreamKey: UPSTREAM_KEY }],
      }),
      csrf,
    })
    if (response.status !== 201) {
      throw new Error(`Connection create failed with ${response.status}: ${await response.text()}`)
    }
    return (await response.json()) as ConnectionBody
  }

  const createKey = async (scope: unknown[]): Promise<string> => {
    const response = await iroha.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'App', scope }),
      csrf,
    })
    if (response.status !== 201) {
      throw new Error(`Key create failed with ${response.status}: ${await response.text()}`)
    }
    return ((await response.json()) as { secret: string }).secret
  }

  const listModels = (token: string | null) =>
    iroha.fetch(`/providers/${connection.handle}/v1/models`, {
      method: 'GET',
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    })

  const refreshCatalog = async () => {
    const response = await iroha.fetch(`/api/v1/admin/providers/${connection.id}/catalog/refresh`, {
      method: 'POST',
      csrf,
    })
    if (response.status !== 200) {
      throw new Error(`Refresh failed with ${response.status}: ${await response.text()}`)
    }
    return (await response.json()) as {
      sync: { lastSuccessAt: string | null; lastFailureAt: string | null; stale: boolean }
      entries: { modelId: string; source: string; excluded: boolean }[]
    }
  }

  test('lists the discovered catalog through an unrestricted Gateway Key', async () => {
    await refreshCatalog()
    const key = await createKey([{ providerId: connection.id }])

    const response = await listModels(key)
    expect(response.status).toBe(200)

    const body = (await response.json()) as { object: string; data: { id: string; object: string }[] }
    expect(body.object).toBe('list')
    expect(body.data.map((model) => model.id).sort()).toEqual([MODEL, 'gpt-4o'].sort())
    expect(body.data.every((model) => model.object === 'model')).toBe(true)
  })

  test('catalog discovery hits a key\'s own base URL override', async () => {
    upstream.calls.length = 0
    const overrideUrl = 'https://override.example.com/v1'
    const response = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle: crypto.randomUUID(),
        displayName: 'Catalog override',
        baseUrl: BASE_URL,
        keys: [{ upstreamKey: 'sk-override-discovery-key', baseUrl: overrideUrl }],
      }),
      csrf,
    })
    if (response.status !== 201) {
      throw new Error(`Connection create failed with ${response.status}: ${await response.text()}`)
    }
    const overrideConnection = (await response.json()) as ConnectionBody

    const refresh = await iroha.fetch(
      `/api/v1/admin/providers/${overrideConnection.id}/catalog/refresh`,
      { method: 'POST', csrf },
    )
    expect(refresh.status).toBe(200)

    const discoveryCall = upstream.calls.find((call) => call.url.startsWith(overrideUrl))
    expect(discoveryCall).toBeDefined()
    expect(discoveryCall?.url).toBe(`${overrideUrl}/models`)
    expect(upstream.calls.every((call) => call.url.startsWith(BASE_URL))).toBe(false)
  })

  test('an exact-model scope lists exactly those models', async () => {
    await refreshCatalog()
    const key = await createKey([{ providerId: connection.id, models: [MODEL] }])

    const response = await listModels(key)
    const body = (await response.json()) as { data: { id: string }[] }
    expect(body.data.map((model) => model.id)).toEqual([MODEL])
  })

  test('a scope listing an unknown model still returns it', async () => {
    await refreshCatalog()
    const key = await createKey([{ providerId: connection.id, models: ['never-catalogued'] }])

    const response = await listModels(key)
    const body = (await response.json()) as { data: { id: string }[] }
    expect(body.data.map((model) => model.id)).toEqual(['never-catalogued'])
  })

  test('rejects a missing, revoked, or out-of-scope key', async () => {
    await refreshCatalog()
    const other = await createConnection()
    const key = await createKey([{ providerId: other.id }])

    const missing = await listModels(null)
    expect(missing.status).toBe(401)

    const outOfScope = await listModels(key)
    expect(outOfScope.status).toBe(403)

    const revoked = await createKey([{ providerId: connection.id }])
    await iroha.fetch(`/api/v1/admin/gateway-keys/${revoked.split('.')[0]}/revoke`, {
      method: 'POST',
      csrf,
    })
    expect((await listModels(revoked)).status).toBe(401)
  })

  test('Owner exclusions never appear in the Models list', async () => {
    await refreshCatalog()
    await iroha.fetch(`/api/v1/admin/providers/${connection.id}/catalog/models/gpt-4o`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ excluded: true }),
      csrf,
    })
    const key = await createKey([{ providerId: connection.id }])

    const response = await listModels(key)
    const body = (await response.json()) as { data: { id: string }[] }
    expect(body.data.map((model) => model.id)).toEqual([MODEL])
  })
})

describe('the Owner model catalog surface', () => {
  let iroha: TestApp
  let csrf: string
  let upstream: ReturnType<typeof mockUpstreamTransport>
  let connection: ConnectionBody

  beforeEach(async () => {
    upstream = mockUpstreamTransport(() => discoveryBody([MODEL, 'gpt-4o']))
    iroha = await createTestApp({ upstreamTransport: upstream.fetch })
    csrf = (await completeSetup(iroha)).csrf
    connection = await createConnection()
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  const createConnection = async (): Promise<ConnectionBody> => {
    const response = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle: crypto.randomUUID(),
        displayName: 'Catalog example',
        baseUrl: BASE_URL,
        keys: [{ upstreamKey: UPSTREAM_KEY }],
      }),
      csrf,
    })
    if (response.status !== 201) {
      throw new Error(`Connection create failed with ${response.status}: ${await response.text()}`)
    }
    return (await response.json()) as ConnectionBody
  }

  const refresh = async () => {
    const response = await iroha.fetch(`/api/v1/admin/providers/${connection.id}/catalog/refresh`, {
      method: 'POST',
      csrf,
    })
    expect(response.status).toBe(200)
    return (await response.json()) as {
      sync: { lastSuccessAt: string | null; lastFailureAt: string | null; stale: boolean; lastFailureMessage: string | null }
      entries: { modelId: string; source: string; excluded: boolean; overrides: Record<string, boolean> | null }[]
    }
  }

  test('a new templated Provider exposes its known models before discovery', async () => {
    upstream.calls.length = 0
    const created = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle: crypto.randomUUID(),
        displayName: 'OpenAI template example',
        baseUrl: BASE_URL,
        keys: [{ upstreamKey: UPSTREAM_KEY }],
        templateId: 'openai',
      }),
      csrf,
    })
    expect(created.status).toBe(201)
    const provider = (await created.json()) as { id: string }

    const response = await iroha.fetch(`/api/v1/admin/providers/${provider.id}/catalog`)
    expect(response.status).toBe(200)
    const catalog = (await response.json()) as {
      entries: { modelId: string; source: string }[]
    }
    expect(catalog.entries).toContainEqual(expect.objectContaining({
      modelId: 'gpt-4o-mini',
      source: 'template',
    }))
    expect(upstream.calls).toHaveLength(0)
  })

  test('a successful refresh discovers models with provenance and freshness', async () => {
    const catalog = await refresh()

    expect(catalog.sync.lastSuccessAt).not.toBeNull()
    expect(catalog.sync.stale).toBe(false)
    expect(catalog.entries.map((entry) => entry.modelId).sort()).toEqual([MODEL, 'gpt-4o'].sort())
    expect(catalog.entries.every((entry) => entry.source === 'discovered')).toBe(true)
    expect(catalog.entries.every((entry) => entry.excluded === false)).toBe(true)
  })

  test('a failed refresh retains the last catalog and marks it stale', async () => {
    await refresh()

    upstream.respondWith(() => new Response('provider is down', { status: 503 }))
    const response = await iroha.fetch(`/api/v1/admin/providers/${connection.id}/catalog/refresh`, {
      method: 'POST',
      csrf,
    })

    expect(response.status).toBe(200)
    const catalog = (await response.json()) as {
      sync: { lastSuccessAt: string | null; lastFailureAt: string | null; stale: boolean; lastFailureMessage: string | null }
      entries: { modelId: string }[]
    }
    expect(catalog.sync.lastFailureAt).not.toBeNull()
    expect(catalog.sync.stale).toBe(true)
    expect(catalog.entries.map((entry) => entry.modelId).sort()).toEqual([MODEL, 'gpt-4o'].sort())
  })

  test('an unparseable discovery answer is a recorded failure, not an error', async () => {
    upstream.respondWith(() => new Response('not json at all', { status: 200 }))
    const response = await iroha.fetch(`/api/v1/admin/providers/${connection.id}/catalog/refresh`, {
      method: 'POST',
      csrf,
    })

    expect(response.status).toBe(200)
    const catalog = (await response.json()) as {
      sync: { lastFailureMessage: string | null; stale: boolean }
    }
    expect(catalog.sync.lastFailureMessage).toContain('usable model list')
  })

  test('an Owner addition survives a later discovery that omits it', async () => {
    await refresh()
    const addResponse = await iroha.fetch(
      `/api/v1/admin/providers/${connection.id}/catalog/models`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modelId: 'custom-model' }),
        csrf,
      },
    )
    expect(addResponse.status).toBe(200)

    upstream.respondWith(() => discoveryBody([MODEL]))
    const catalog = await refresh()

    expect(catalog.entries.map((entry) => entry.modelId).sort()).toEqual([MODEL, 'custom-model'].sort())
    const custom = catalog.entries.find((entry) => entry.modelId === 'custom-model')
    expect(custom?.source).toBe('owner_added')
  })

  test('an Owner exclusion survives a later discovery that reports the model again', async () => {
    await refresh()
    await iroha.fetch(`/api/v1/admin/providers/${connection.id}/catalog/models/gpt-4o`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ excluded: true }),
      csrf,
    })

    const catalog = await refresh()
    const excluded = catalog.entries.find((entry) => entry.modelId === 'gpt-4o')
    expect(excluded?.excluded).toBe(true)
  })

  test('per-model capability overrides are stored and returned', async () => {
    await refresh()
    const response = await iroha.fetch(`/api/v1/admin/providers/${connection.id}/catalog/models/${MODEL}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ overrides: { streaming: true, tools: false } }),
      csrf,
    })

    expect(response.status).toBe(200)
    const catalog = (await response.json()) as {
      entries: { modelId: string; overrides: Record<string, boolean> | null }[]
    }
    const entry = catalog.entries.find((candidate) => candidate.modelId === MODEL)
    expect(entry?.overrides).toEqual({ streaming: true, tools: false })
  })

  test('removing an Owner model drops only the owner-added row', async () => {
    await refresh()
    await iroha.fetch(`/api/v1/admin/providers/${connection.id}/catalog/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: 'custom-model' }),
      csrf,
    })

    await iroha.fetch(`/api/v1/admin/providers/${connection.id}/catalog/models/custom-model`, {
      method: 'DELETE',
      csrf,
    })

    const catalog = await refresh()
    expect(catalog.entries.map((entry) => entry.modelId)).not.toContain('custom-model')
  })

  test('an excluded model is refused on inference', async () => {
    await refresh()
    await iroha.fetch(`/api/v1/admin/providers/${connection.id}/catalog/models/${MODEL}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ excluded: true }),
      csrf,
    })
    const key = await createKey([{ providerId: connection.id }])
    const callsBefore = upstream.calls.length

    const response = await iroha.fetch(`/providers/${connection.handle}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }),
    })

    expect(response.status).toBe(403)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('model_excluded')
    expect(upstream.calls).toHaveLength(callsBefore)
  })

  const createKey = async (scope: unknown[]): Promise<string> => {
    const response = await iroha.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'App', scope }),
      csrf,
    })
    if (response.status !== 201) {
      throw new Error(`Key create failed with ${response.status}: ${await response.text()}`)
    }
    return ((await response.json()) as { secret: string }).secret
  }
})
