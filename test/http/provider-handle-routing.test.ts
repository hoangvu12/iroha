import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { completeSetup, createTestApp, type TestApp } from '../support/app.ts'
import { controlledSse, mockUpstreamTransport, sseEvent } from '../support/inference.ts'

describe('provider-scoped Provider Handle routing', () => {
  let iroha: TestApp
  let csrf: string
  let upstream: ReturnType<typeof mockUpstreamTransport>

  beforeEach(async () => {
    upstream = mockUpstreamTransport()
    iroha = await createTestApp({ upstreamTransport: upstream.fetch })
    csrf = (await completeSetup(iroha)).csrf
  })

  afterEach(async () => await iroha.dispose())

  test('resolves a Handle before internal Provider-ID authorization and preserves the exact model', async () => {
    const provider = await createProvider('readable-provider')
    const secret = await createKey(provider.id)

    const response = await iroha.fetch(`/providers/${provider.handle}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: 'vendor/nested/model', messages: [{ role: 'user', content: 'Hello' }] }),
    })

    expect(response.status).toBe(200)
    expect(JSON.parse(upstream.calls[0]!.body!)).toMatchObject({ model: 'vendor/nested/model' })
  })

  test('rejects invalid Handles before lookup and legacy Provider IDs as sanitized not-allowed responses', async () => {
    const provider = await createProvider('public-handle')
    const secret = await createKey(provider.id)

    const invalid = await iroha.fetch('/providers/UPPER/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ error: { code: 'invalid_provider_handle' } })

    const legacy = await iroha.fetch(`/providers/${provider.id}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
    })
    expect(legacy.status).toBe(400)
    expect(await legacy.json()).toMatchObject({ error: { code: 'invalid_provider_handle' } })
    expect(upstream.calls).toHaveLength(0)
  })

  test('directory exposes both identities and builds the scoped URL from the Handle', async () => {
    const provider = await createProvider('directory-provider')
    const secret = await createKey(provider.id)
    const response = await iroha.fetch('/api/v1/directory/providers', {
      headers: { authorization: `Bearer ${secret}` },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ providers: [{
      id: provider.id,
      handle: provider.handle,
      url: `/providers/${provider.handle}/v1`,
    }] })
  })

  test('models, Responses, and Anthropic Messages all accept the Handle selector', async () => {
    const provider = await createProvider('all-scoped-surfaces')
    const secret = await createKey(provider.id)
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${secret}` }

    const models = await iroha.fetch(`/providers/${provider.handle}/v1/models`, { headers })
    expect(models.status).toBe(200)

    upstream.respondWith((call) => call.url.endsWith('/responses')
      ? Response.json({ id: 'resp_1', object: 'response', model: 'exact/model' })
      : Response.json({ id: 'chatcmpl_1', object: 'chat.completion', created: 1, model: 'exact/model', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }))
    const responses = await iroha.fetch(`/providers/${provider.handle}/v1/responses`, {
      method: 'POST', headers, body: JSON.stringify({ model: 'exact/model', input: 'Hello' }),
    })
    expect(responses.status).toBe(200)

    const messages = await iroha.fetch(`/providers/${provider.handle}/v1/messages`, {
      method: 'POST', headers, body: JSON.stringify({ model: 'exact/model', max_tokens: 16, messages: [{ role: 'user', content: 'Hello' }] }),
    })
    expect(messages.status).toBe(200)
    expect(upstream.calls.map((call) => JSON.parse(call.body!).model)).toEqual(['exact/model', 'exact/model'])
  })

  test('unknown, inaccessible, archived, and disabled Handles share one private refusal', async () => {
    const allowed = await createProvider('allowed-provider')
    const hidden = await createProvider('hidden-provider')
    const archived = await createProvider('archived-provider')
    const disabled = await createProvider('disabled-provider')
    const secret = await createKey(allowed.id)
    await iroha.fetch(`/api/v1/admin/providers/${archived.id}/archive`, { method: 'POST', csrf })
    await iroha.fetch(`/api/v1/admin/providers/${disabled.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, csrf,
      body: JSON.stringify({ enabled: false }),
    })

    for (const handle of ['does-not-exist', hidden.handle, archived.handle, disabled.handle]) {
      const response = await iroha.fetch(`/providers/${handle}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
      })
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: { code: 'provider_not_allowed' } })
    }
    expect(upstream.calls).toHaveLength(0)
  })

  test('a Handle-routed stream preserves chunks and propagates downstream cancellation', async () => {
    const provider = await createProvider('stream-provider')
    const secret = await createKey(provider.id)
    let controlled: ReturnType<typeof controlledSse> | undefined
    upstream.respondWith((call) => {
      controlled = controlledSse(call)
      return new Response(controlled.stream, { headers: { 'content-type': 'text/event-stream' } })
    })

    const response = await iroha.fetch(`/providers/${provider.handle}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: 'nested/stream-model', stream: true, messages: [] }),
    })
    controlled!.enqueue(sseEvent(JSON.stringify({ model: 'nested/stream-model', choices: [] })))
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('nested/stream-model')
    await reader.cancel()
    expect(upstream.calls[0]!.signal?.aborted).toBe(true)
  })

  async function createProvider(handle: string): Promise<{ id: string; handle: string }> {
    const response = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST', headers: { 'content-type': 'application/json' }, csrf,
      body: JSON.stringify({ handle, displayName: 'Example', baseUrl: 'https://api.example.com/v1', keys: [{ upstreamKey: 'sk-upstream-secret-value' }] }),
    })
    return await response.json() as { id: string; handle: string }
  }

  async function createKey(providerId: string): Promise<string> {
    const response = await iroha.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST', headers: { 'content-type': 'application/json' }, csrf,
      body: JSON.stringify({ name: 'App', scope: [{ providerId }] }),
    })
    return (await response.json() as { secret: string }).secret
  }
})
