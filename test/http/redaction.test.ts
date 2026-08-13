import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  completeSetup,
  createTestApp,
  errorCode,
  type TestApp,
} from '../support/app.ts'
import { mockUpstreamTransport } from '../support/inference.ts'

const UPSTREAM_KEY = 'sk-upstream-secret-value-for-redaction-tests'
const SECONDARY_KEY = 'sk-secondary-secret-value-for-redaction-tests'
const BASE_URL = 'https://api.example.com/v1'
const MODEL = 'gpt-4o-mini'

/**
 * Systematic redaction coverage: seed secret-like values through every path
 * the Owner could observe (request body, error response, audit feed, request
 * history) and prove they never appear in Iroha's output. A regression here
 * would be a real leak, so the assertions are explicit about substring
 * presence rather than just structural shape.
 */
describe('secret redaction across the Owner surface', () => {
  let iroha: TestApp
  let csrf: string
  let upstream: ReturnType<typeof mockUpstreamTransport>

  beforeEach(async () => {
    upstream = mockUpstreamTransport()
    iroha = await createTestApp({ upstreamTransport: upstream.fetch })
    csrf = (await completeSetup(iroha)).csrf
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  const createConnection = async (): Promise<{ id: string }> => {
    const response = await iroha.fetch('/api/v1/admin/provider-connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Example',
        baseUrl: BASE_URL,
        upstreamKey: UPSTREAM_KEY,
      }),
      csrf,
    })
    if (response.status !== 201) {
      throw new Error(`Connection create failed with ${response.status}: ${await response.text()}`)
    }
    return (await response.json()) as { id: string }
  }

  const createKey = async (providerId: string): Promise<{ secret: string; id: string }> => {
    const response = await iroha.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'App', scope: [{ providerId }] }),
      csrf,
    })
    if (response.status !== 201) {
      throw new Error(`Key create failed with ${response.status}: ${await response.text()}`)
    }
    return (await response.json()) as { secret: string; id: string }
  }

  test('caller error responses never echo Upstream Key material or bearer tokens', async () => {
    const connection = await createConnection()
    const { secret } = await createKey(connection.id)

    // Seed a Bearer-shaped credential inside an "X-Echo" header and force the
    // upstream to surface it in its own response body so a leak path is open.
    upstream.respondWith((call) => {
      const echo = call.headers['x-echo']
      return new Response(
        JSON.stringify({ error: { message: `seen: ${echo ?? ''}` } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )
    })

    const response = await iroha.fetch(`/providers/${connection.id}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
        'x-echo': `${UPSTREAM_KEY} Bearer ${SECONDARY_KEY}`,
      },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }),
    })

    const text = await response.text()
    expect(response.status).toBe(400)
    expect(text).not.toContain(UPSTREAM_KEY)
    expect(text).not.toContain(SECONDARY_KEY)
  })

  test('audit feed does not record Upstream Key values even when the Owner supplies one in an error message', async () => {
    const connection = await createConnection()
    // Mutate the connection so the audit feed logs it. The base URL gets a
    // syntactically valid value with a secret-shaped fragment so a redaction
    // bug would surface it.
    const maliciousBase = `https://attacker.example/v1?leak=${UPSTREAM_KEY}`
    const update = await iroha.fetch(
      `/api/v1/admin/provider-connections/${connection.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl: maliciousBase }),
        csrf,
      },
    )
    expect(update.status).toBe(200)

    const response = await iroha.fetch('/api/v1/admin/audit')
    const body = (await response.json()) as { events: { action: string; detail: unknown }[] }
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain(UPSTREAM_KEY)
  })

  test('request history never stores prompts, responses, or Upstream Key material', async () => {
    const connection = await createConnection()
    const { secret } = await createKey(connection.id)
    upstream.respondWith(() =>
      Response.json({
        id: 'cmpl-leak-check',
        object: 'chat.completion',
        created: 1,
        model: MODEL,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: `response-leak-${UPSTREAM_KEY}` },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
    )

    const response = await iroha.fetch(`/providers/${connection.id}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: `prompt-leak-${SECONDARY_KEY}` }],
      }),
    })
    expect(response.status).toBe(200)

    const requestId = response.headers.get('x-request-id') ?? ''
    const detail = await iroha.fetch(`/api/v1/admin/requests/${requestId}`)
    const body = (await detail.json()) as { event: { model: string; keyId: string | null }; attempts: unknown[] }
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('prompt-leak')
    expect(serialized).not.toContain('response-leak')
    expect(serialized).not.toContain(UPSTREAM_KEY)
    expect(serialized).not.toContain(SECONDARY_KEY)
    expect(body.event.model).toBe(MODEL)
  })

  test('management error bodies never include the submitted secret value', async () => {
    const response = await iroha.fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: `${UPSTREAM_KEY}-as-password` }),
    })
    expect(response.status).toBe(401)
    const text = await response.text()
    expect(text).not.toContain(UPSTREAM_KEY)
  })

  test('validation errors redact the submitted Upstream Key in Provider-Connection creation', async () => {
    // An invalid base URL triggers validation. The error body must not echo
    // the secret value back; the Owner's secret material must never appear
    // in a diagnostic, even when the validation message references the field.
    const maliciousKey = `${UPSTREAM_KEY}-malicious`
    const response = await iroha.fetch('/api/v1/admin/provider-connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Example',
        baseUrl: 'not-a-url',
        upstreamKey: maliciousKey,
      }),
      csrf,
    })
    expect(response.status).toBe(400)
    const text = await response.text()
    expect(text).not.toContain(maliciousKey)
    const body = JSON.parse(text) as { error: { code: string } }
    expect(body.error.code).toBe('validation_failed')
  })
})