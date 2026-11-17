/**
 * An Owner addition joins every curated Upstream Key's allow-list (ADR-0031).
 *
 * A Provider whose every Key carried an explicit allow-list refused a model the
 * Owner had just added as `model_unroutable`, because no Key's list named it.
 * Adding the model now puts it on each Key's allow-list in the same operation,
 * except a Key whose deny-list names it; a Key with no allow-list stays open.
 * Removing the addition takes it back off. Asserted at the HTTP seam
 * (ui-testing.md).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { completeSetup, createTestApp, type TestApp } from '../support/app.ts'
import { mockUpstreamTransport } from '../support/inference.ts'

const KNOWN = 'known-model'
const ADDED = 'gpt-hand-added'

interface KeyDto {
  readonly id: string
  readonly allowedModels: readonly string[] | null
  readonly deniedModels: readonly string[] | null
}

describe('Owner addition and curated allow-lists', () => {
  let iroha: TestApp
  let upstream: ReturnType<typeof mockUpstreamTransport>
  let csrf: string
  let providerId: string
  let keyIds: string[]

  const json = async <T>(path: string, init?: Parameters<TestApp['fetch']>[1]): Promise<T> => {
    const response = await iroha.fetch(path, init)
    expect({ path, ok: response.ok, status: response.status }).toMatchObject({ ok: true })
    return (await response.json()) as T
  }
  const patchKey = async (keyId: string, patch: object) =>
    await json(`/api/v1/admin/providers/${providerId}/keys/${keyId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
      csrf,
    })
  const keys = async () => (await json<{ keys: KeyDto[] }>(`/api/v1/admin/providers/${providerId}`)).keys
  const addModel = async (modelId: string) =>
    await json(`/api/v1/admin/providers/${providerId}/catalog/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId }),
      csrf,
    })
  const testRequest = async (model: string) =>
    await iroha.fetch(`/api/v1/admin/providers/${providerId}/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, protocol: 'openai' }),
      csrf,
    })

  describe('a Provider whose every Key is curated', () => {
    beforeEach(async () => {
      upstream = mockUpstreamTransport()
      upstream.respondWith((call) =>
        call.url.endsWith('/models')
          ? new Response('{"error":"unauthorized"}', { status: 401 })
          : Response.json({
              id: 'chatcmpl-curated',
              object: 'chat.completion',
              model: ADDED,
              choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            }),
      )
      iroha = await createTestApp({ upstreamTransport: upstream.fetch })
      csrf = (await completeSetup(iroha)).csrf

      const created = await json<{ id: string; keys: KeyDto[] }>('/api/v1/admin/providers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: 'Curated',
          handle: 'curated',
          baseUrl: 'https://api.example.com/v1',
          keys: [{ upstreamKey: 'sk-curated-a' }, { upstreamKey: 'sk-curated-b' }],
        }),
        csrf,
      })
      providerId = created.id
      keyIds = created.keys.map((key) => key.id)
      await patchKey(keyIds[0]!, { allowedModels: [KNOWN] })
      await patchKey(keyIds[1]!, { allowedModels: ['other-model', KNOWN] })
      upstream.reset()
    })

    afterEach(async () => await iroha.dispose())

    test('an added model routes at once instead of being refused as model_unroutable', async () => {
      await addModel(ADDED)

      const tested = await testRequest(ADDED)
      expect({ status: tested.status, body: await tested.text() }).toMatchObject({ status: 200 })
      expect(upstream.calls).toHaveLength(1)
      expect(JSON.parse(upstream.calls[0]!.body ?? '{}')).toMatchObject({ model: ADDED })
    })

    test('the addition is audited once with the number of allow-lists it joined, and no key material', async () => {
      await addModel(ADDED)

      const audit = await iroha.fetch('/api/v1/admin/audit?actionPrefix=model_catalog.owner_added')
      const body = (await audit.json()) as { events: { detail: unknown }[] }
      expect(body.events).toHaveLength(1)
      expect(body.events[0]!.detail).toMatchObject({ providerId, modelId: ADDED, allowListsJoined: 2 })
      const text = JSON.stringify(body)
      expect(text).not.toContain('sk-curated-a')
      expect(text).not.toContain('sk-curated-b')
    })
  })

  describe('a Provider with curated, open and denying Keys', () => {
    beforeEach(async () => {
      upstream = mockUpstreamTransport()
      upstream.respondWith((call) =>
        call.url.endsWith('/models')
          ? new Response('{"error":"unauthorized"}', { status: 401 })
          : Response.json({
              id: 'chatcmpl-mixed',
              object: 'chat.completion',
              model: ADDED,
              choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            }),
      )
      iroha = await createTestApp({ upstreamTransport: upstream.fetch })
      csrf = (await completeSetup(iroha)).csrf

      const created = await json<{ id: string; keys: KeyDto[] }>('/api/v1/admin/providers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: 'Mixed',
          handle: 'mixed',
          baseUrl: 'https://api.example.com/v1',
          keys: [
            { upstreamKey: 'sk-curated-a' },
            { upstreamKey: 'sk-curated-b' },
            { upstreamKey: 'sk-open' },
            { upstreamKey: 'sk-denying' },
          ],
        }),
        csrf,
      })
      providerId = created.id
      keyIds = created.keys.map((key) => key.id)
      await patchKey(keyIds[0]!, { allowedModels: [KNOWN] })
      await patchKey(keyIds[1]!, { allowedModels: [] })
      await patchKey(keyIds[3]!, { allowedModels: [KNOWN], deniedModels: [ADDED] })
      upstream.reset()
    })

    afterEach(async () => await iroha.dispose())

    test('the model joins exactly the curated Keys whose deny-list does not name it', async () => {
      await addModel(ADDED)

      const [curatedA, curatedB, open, denying] = await keys()
      expect(curatedA!.allowedModels).toEqual([KNOWN, ADDED])
      expect(curatedB!.allowedModels).toEqual([ADDED])
      expect(open!.allowedModels).toBeNull()
      expect(denying!.allowedModels).toEqual([KNOWN])
      expect(denying!.deniedModels).toEqual([ADDED])
    })

    test('removing the addition takes it back off the allow-lists and leaves the rest alone', async () => {
      await addModel(ADDED)
      await json(`/api/v1/admin/providers/${providerId}/catalog/models/${ADDED}`, { method: 'DELETE', csrf })

      const [curatedA, curatedB, open, denying] = await keys()
      expect(curatedA!.allowedModels).toEqual([KNOWN])
      expect(curatedB!.allowedModels).toEqual([])
      expect(open!.allowedModels).toBeNull()
      expect(denying!.allowedModels).toEqual([KNOWN])

      const audit = await iroha.fetch('/api/v1/admin/audit?actionPrefix=model_catalog.owner_removed')
      const body = (await audit.json()) as { events: { detail: unknown }[] }
      expect(body.events[0]!.detail).toMatchObject({ modelId: ADDED, removed: true, allowListsLeft: 2 })
    })

    test('excluding the model does not touch any allow-list', async () => {
      await addModel(ADDED)
      await json(`/api/v1/admin/providers/${providerId}/catalog/models/${ADDED}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ excluded: true }),
        csrf,
      })

      const [curatedA, curatedB] = await keys()
      expect(curatedA!.allowedModels).toEqual([KNOWN, ADDED])
      expect(curatedB!.allowedModels).toEqual([ADDED])
    })
  })
})
