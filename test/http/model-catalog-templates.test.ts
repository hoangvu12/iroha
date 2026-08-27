import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  completeSetup,
  createTestApp,
  type TestApp,
} from '../support/app.ts'
import { mockUpstreamTransport } from '../support/inference.ts'

const UPSTREAM_KEY = 'sk-upstream-secret-value-for-tests'
const BASE_URL = 'https://api.openai.com/v1'

interface ConnectionBody {
  id: string
  displayName: string
  templateId: string | null
}

interface CatalogBody {
  sync: { lastSuccessAt: string | null; lastFailureAt: string | null; stale: boolean }
  entries: { modelId: string; source: string; excluded: boolean }[]
}

describe('Provider Template contribution to the model catalog', () => {
  let iroha: TestApp
  let csrf: string
  let upstream: ReturnType<typeof mockUpstreamTransport>
  let connection: ConnectionBody

  beforeEach(async () => {
    // The discovery answer omits one of OpenAI's curated models; the template
    // contribution must fill that gap from data, not from the upstream call.
    upstream = mockUpstreamTransport(() =>
      Response.json({
        object: 'list',
        data: [{ id: 'gpt-4o-mini', object: 'model', created: 1_700_000_000 }],
      }),
    )
    iroha = await createTestApp({ upstreamTransport: upstream.fetch })
    csrf = (await completeSetup(iroha)).csrf
    connection = await createConnection('OpenAI via template', 'openai')
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  const createConnection = async (displayName: string, templateId: string, baseUrl = BASE_URL): Promise<ConnectionBody> => {
    const response = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle: crypto.randomUUID(),
        displayName,
        baseUrl,
        keys: [{ upstreamKey: UPSTREAM_KEY }],
        templateId,
      }),
      csrf,
    })
    if (response.status !== 201) {
      throw new Error(`Create failed with ${response.status}: ${await response.text()}`)
    }
    return (await response.json()) as ConnectionBody
  }

  const refreshCatalog = async (): Promise<CatalogBody> => {
    const response = await iroha.fetch(
      `/api/v1/admin/providers/${connection.id}/catalog/refresh`,
      { method: 'POST', csrf },
    )
    if (response.status !== 200) {
      throw new Error(`Refresh failed with ${response.status}: ${await response.text()}`)
    }
    return (await response.json()) as CatalogBody
  }

  test('template-known models appear in the catalog with the template source', async () => {
    const catalog = await refreshCatalog()

    // The curated model the discovery call did NOT report must still be present,
    // sourced from the template rather than from the Provider.
    const curated = catalog.entries.find((entry) => entry.modelId === 'gpt-4o')
    expect(curated?.source).toBe('template')

    // The discovered model keeps its discovered provenance even though the
    // template also knows it; the template never overwrites discovery.
    const discovered = catalog.entries.find((entry) => entry.modelId === 'gpt-4o-mini')
    expect(discovered?.source).toBe('discovered')
  })

  test('a Provider with best-effort discovery falls back to template knowledge', async () => {
    connection = await createConnection('Z.ai Coding Plan', 'zai')
    upstream.respondWith(() => new Response('not a usable model list', { status: 200 }))
    upstream.calls.length = 0

    const catalog = await refreshCatalog()

    expect(catalog.sync.lastSuccessAt).not.toBeNull()
    expect(catalog.sync.lastFailureAt).toBeNull()
    expect(catalog.sync.stale).toBe(false)
    expect(catalog.entries.map((entry) => entry.modelId)).toContain('glm-5.3')
    expect(catalog.entries.every((entry) => entry.source === 'template')).toBe(true)
    expect(upstream.calls).toHaveLength(1)
    expect(upstream.calls[0]?.url).toBe('https://api.openai.com/api/coding/paas/v4/models')
  })

  test('a Provider with best-effort discovery uses a usable upstream model list', async () => {
    connection = await createConnection('Z.ai Coding Plan', 'zai')
    upstream.respondWith(() => Response.json({ data: [{ id: 'glm-upstream-new' }] }))

    const catalog = await refreshCatalog()

    expect(catalog.entries).toContainEqual(expect.objectContaining({
      modelId: 'glm-upstream-new',
      source: 'discovered',
    }))
  })

  test('Z.ai discovers models through the coding endpoint when inference uses Anthropic', async () => {
    connection = await createConnection('Z.ai Anthropic', 'zai', 'https://api.z.ai/api/anthropic')
    upstream.respondWith(() => Response.json({ data: [{ id: 'glm-5.3-flash' }] }))
    upstream.calls.length = 0

    const catalog = await refreshCatalog()

    expect(upstream.calls).toHaveLength(1)
    expect(upstream.calls[0]?.url).toBe('https://api.z.ai/api/coding/paas/v4/models')
    expect(catalog.entries).toContainEqual(expect.objectContaining({
      modelId: 'glm-5.3-flash',
      source: 'discovered',
    }))
  })

  test('a hand-configured connection has no template-known models', async () => {
    const hand = await createConnection('Hand-configured', 'generic-openai-compatible')
    connection = hand
    const catalog = await refreshCatalog()
    const template = catalog.entries.find((entry) => entry.source === 'template')
    expect(template).toBeUndefined()
  })

  test('a template-known model survives a future discovery that omits it', async () => {
    await refreshCatalog()

    // First discovery already reported `gpt-4o-mini`; the curated
    // `gpt-4o` came from the template. A later discovery that omits
    // gpt-4o must not delete the template-known row.
    upstream.respondWith(() =>
      Response.json({
        object: 'list',
        data: [{ id: 'gpt-4o-mini', object: 'model', created: 1_700_000_000 }],
      }),
    )
    const catalog = await refreshCatalog()
    const stillKnown = catalog.entries.find((entry) => entry.modelId === 'gpt-4o')
    expect(stillKnown?.source).toBe('template')
  })

  test('an Owner exclusion survives a template-known model', async () => {
    await refreshCatalog()

    // Block the template-known `gpt-4o`; the catalog must keep the row so
    // the Owner can review the block, but the model must not join the
    // provider-scoped Models list.
    await iroha.fetch(
      `/api/v1/admin/providers/${connection.id}/catalog/models/gpt-4o`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ excluded: true }),
        csrf,
      },
    )

    const response = await iroha.fetch(`/api/v1/admin/providers/${connection.id}/catalog`)
    const body = (await response.json()) as {
      entries: { modelId: string; excluded: boolean; source: string }[]
    }
    const excluded = body.entries.find((entry) => entry.modelId === 'gpt-4o')
    expect(excluded?.excluded).toBe(true)
    expect(excluded?.source).toBe('template')
  })
})
