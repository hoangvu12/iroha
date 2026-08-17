import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { completeSetup, createTestApp, type TestApp } from '../support/app.ts'
import { mockUpstreamTransport } from '../support/inference.ts'

describe('Owner inference test', () => {
  let iroha: TestApp
  let csrf: string
  let providerId: string
  let upstream: ReturnType<typeof mockUpstreamTransport>

  beforeEach(async () => {
    upstream = mockUpstreamTransport()
    iroha = await createTestApp({ upstreamTransport: upstream.fetch })
    csrf = (await completeSetup(iroha)).csrf
    const created = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Owner test',
        handle: 'owner-test',
        baseUrl: 'https://api.example.com/v1',
        keys: [{ upstreamKey: 'sk-owner-test' }],
      }),
      csrf,
    })
    providerId = ((await created.json()) as { id: string }).id
  })

  afterEach(async () => await iroha.dispose())

  test('uses the Owner Session without requiring a Gateway Key', async () => {
    upstream.respondWith(() => Response.json({
      id: 'chatcmpl-owner-test',
      object: 'chat.completion',
      model: 'served-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello back' }, finish_reason: 'stop' }],
    }))

    const response = await iroha.fetch(`/api/v1/admin/providers/${providerId}/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'requested-model', protocol: 'openai' }),
      csrf,
    })

    expect(response.status).toBe(200)
    expect(upstream.calls).toHaveLength(1)
    expect(JSON.parse(upstream.calls[0]!.body ?? '{}')).toMatchObject({
      model: 'requested-model',
      messages: [{ role: 'user', content: 'Hello' }],
    })

    const requestId = response.headers.get('x-request-id')
    const history = await iroha.fetch(`/api/v1/admin/requests/${requestId}`)
    const recorded = (await history.json()) as { event: { gatewayKeyName?: string } }
    expect(recorded.event.gatewayKeyName).toBe('Owner session')
  })

  test('requires the Owner CSRF token', async () => {
    const response = await iroha.fetch(`/api/v1/admin/providers/${providerId}/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'requested-model', protocol: 'openai' }),
    })

    expect(response.status).toBe(403)
    expect(upstream.calls).toHaveLength(0)
  })
})
