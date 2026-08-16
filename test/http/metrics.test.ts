import { afterEach, describe, expect, test } from 'bun:test'
import {
  completeSetup,
  createTestApp,
  type TestApp,
} from '../support/app.ts'
import { mockUpstreamTransport } from '../support/inference.ts'

const UPSTREAM_KEY = 'sk-upstream-secret-value-for-tests'
const BASE_URL = 'https://api.example.com/v1'
const MODEL = 'gpt-4o-mini'

const running: TestApp[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map((app) => app.dispose()))
})

describe('optional metrics', () => {
  test('requires an Owner, defaults to disabled, and emits bounded private counters', async () => {
    const upstream = mockUpstreamTransport()
    const test = await createTestApp({ upstreamTransport: upstream.fetch })
    running.push(test)
    const document = (await (await test.fetch('/docs/json')).json()) as { paths?: Record<string, unknown> }
    expect(Object.keys(document.paths ?? {})).toContain('/api/v1/admin/metrics')
    const unauthenticated = await test.fetch('/api/v1/admin/metrics')
    expect(unauthenticated.status).toBe(401)

    const signedIn = await completeSetup(test)
    const connectionResponse = await test.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Metrics example', handle: 'metrics-example', baseUrl: BASE_URL, keys: [{ upstreamKey: UPSTREAM_KEY }] }),
      csrf: signedIn.csrf,
    })
    const connection = (await connectionResponse.json()) as { id: string; handle: string }
    const keyResponse = await test.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Metrics app', scope: [{ providerId: connection.id }] }),
      csrf: signedIn.csrf,
    })
    const key = (await keyResponse.json()) as { secret: string }

    const disabled = await test.fetch('/api/v1/admin/metrics')
    expect(disabled.status).toBe(404)

    const enable = await test.fetch('/api/v1/admin/settings/metrics', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
      csrf: signedIn.csrf,
    })
    expect(enable.status).toBe(200)
    expect(await enable.json()).toEqual({ enabled: true })

    const inference = await test.fetch(`/providers/${connection.handle}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key.secret}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hello' }] }),
    })
    expect(inference.status).toBe(200)
    const requestId = inference.headers.get('x-request-id')
    expect(requestId).toBeTruthy()

    const metrics = await test.fetch('/api/v1/admin/metrics')
    expect(metrics.status).toBe(200)
    expect(metrics.headers.get('content-type')).toContain('text/plain')
    const body = await metrics.text()
    expect(body).toContain('iroha_requests_total{outcome="success"} 1')
    expect(body).toContain('iroha_request_duration_seconds_count 1')
    expect(body).toContain('iroha_upstream_key_health{health="active"} 1')
    expect(body).not.toContain(requestId!)
    expect(body).not.toContain(UPSTREAM_KEY)
    expect(body).not.toContain(connection.id)
    expect(body).not.toContain(MODEL)
    expect(body).not.toContain(key.secret)
  })
})
