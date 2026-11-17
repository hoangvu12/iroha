/**
 * The Code Snippet card offers the callable part of what the Models card lists.
 *
 * The card once defaulted to the Provider's first Upstream Key and narrowed
 * the list to that key's allow-list, so a hand-added model the first key does
 * not name vanished from the snippet while the Models card still showed it,
 * even though the Gateway may route it through another key. The
 * shared `snippetModelIds` rule is asserted here against the real HTTP
 * contracts both cards read (ui-testing.md: coverage lives at the HTTP seam).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { snippetModelIds } from '../../ui/src/lib/snippet-models.ts'
import { completeSetup, createTestApp, type TestApp } from '../support/app.ts'
import { mockUpstreamTransport } from '../support/inference.ts'

const DISCOVERED = 'discovered-model'
const HAND_ADDED = 'hand-added-model'
const BLOCKED = 'blocked-model'

interface CatalogDto {
  readonly entries: readonly { readonly modelId: string; readonly source: string; readonly excluded: boolean }[]
}

interface KeyDto {
  readonly id: string
  readonly allowedModels: readonly string[] | null
  readonly deniedModels: readonly string[] | null
}

describe('Code Snippet model list', () => {
  let iroha: TestApp
  let upstream: ReturnType<typeof mockUpstreamTransport>
  let csrf: string
  let providerId: string

  const json = async <T>(path: string, init?: Parameters<TestApp['fetch']>[1]): Promise<T> => {
    const response = await iroha.fetch(path, init)
    expect(response.ok).toBe(true)
    return (await response.json()) as T
  }

  beforeEach(async () => {
    upstream = mockUpstreamTransport()
    upstream.respondWith((call) =>
      call.url.endsWith('/models')
        ? Response.json({ object: 'list', data: [DISCOVERED, BLOCKED].map((id) => ({ id, object: 'model' })) })
        : Response.json({
            id: 'chatcmpl-snippet',
            object: 'chat.completion',
            model: HAND_ADDED,
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          }),
    )
    iroha = await createTestApp({ upstreamTransport: upstream.fetch })
    csrf = (await completeSetup(iroha)).csrf

    const created = await json<{ id: string; keys: KeyDto[] }>('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Snippet models',
        handle: 'snippet-models',
        baseUrl: 'https://api.example.com/v1',
        keys: [{ upstreamKey: 'sk-curated' }, { upstreamKey: 'sk-open' }],
      }),
      csrf,
    })
    providerId = created.id

    // The first key names only the discovered model; the second is open.
    await json(`/api/v1/admin/providers/${providerId}/keys/${created.keys[0]!.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowedModels: [DISCOVERED] }),
      csrf,
    })
    await json(`/api/v1/admin/providers/${providerId}/catalog/refresh`, { method: 'POST', csrf })
    await json(`/api/v1/admin/providers/${providerId}/catalog/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: HAND_ADDED }),
      csrf,
    })
    await json(`/api/v1/admin/providers/${providerId}/catalog/models/${BLOCKED}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ excluded: true }),
      csrf,
    })
    upstream.reset()
  })

  afterEach(async () => await iroha.dispose())

  test('offers every non-excluded catalogued model by default, hand-added ones included', async () => {
    const catalog = await json<CatalogDto>(`/api/v1/admin/providers/${providerId}/catalog`)
    const callable = catalog.entries.filter((entry) => !entry.excluded).map((entry) => entry.modelId)

    expect(catalog.entries.find((entry) => entry.modelId === HAND_ADDED)?.source).toBe('owner_added')
    expect(callable).toContain(DISCOVERED)
    expect(callable).toContain(HAND_ADDED)
    expect(callable).not.toContain(BLOCKED)
    expect([...snippetModelIds(catalog, null)].sort()).toEqual([...callable].sort())
  })

  test('choosing a key narrows the list to what that key serves', async () => {
    const catalog = await json<CatalogDto>(`/api/v1/admin/providers/${providerId}/catalog`)
    const provider = await json<{ keys: KeyDto[] }>(`/api/v1/admin/providers/${providerId}`)
    const [curated, open] = provider.keys

    expect(snippetModelIds(catalog, curated!)).toEqual([DISCOVERED])
    expect([...snippetModelIds(catalog, open!)].sort()).toEqual([DISCOVERED, HAND_ADDED].sort())
  })
})
