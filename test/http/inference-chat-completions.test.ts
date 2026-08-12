import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  completeSetup,
  createTestApp,
  fakeKeyProbe,
  type TestApp,
} from '../support/app.ts'
import {
  mockUpstreamTransport,
  type RecordedUpstreamCall,
} from '../support/inference.ts'

const UPSTREAM_KEY = 'sk-upstream-secret-value-for-tests'
const BASE_URL = 'https://api.example.com/v1'
const MODEL = 'gpt-4o-mini'
const OTHER_MODEL = 'gpt-4o'

interface ConnectionBody {
  id: string
  displayName: string
  keys: { id: string; health: string }[]
}

describe('provider-scoped Chat Completions', () => {
  let iroha: TestApp
  let csrf: string
  let upstream: ReturnType<typeof mockUpstreamTransport>
  let connection: ConnectionBody
  let path: string

  beforeEach(async () => {
    upstream = mockUpstreamTransport()
    iroha = await createTestApp({ upstreamTransport: upstream.fetch })
    csrf = (await completeSetup(iroha)).csrf
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  const createConnection = async (
    fields: Record<string, unknown> = {},
  ): Promise<ConnectionBody> => {
    const response = await iroha.fetch('/api/v1/admin/provider-connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Example',
        baseUrl: BASE_URL,
        upstreamKey: UPSTREAM_KEY,
        ...fields,
      }),
      csrf,
    })
    if (response.status !== 201) {
      throw new Error(`Connection create failed with ${response.status}: ${await response.text()}`)
    }
    return (await response.json()) as ConnectionBody
  }

  const createKey = async (scope: unknown[]): Promise<{ secret: string }> => {
    const response = await iroha.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'App credential', scope }),
      csrf,
    })
    if (response.status !== 201) {
      throw new Error(`Key create failed with ${response.status}: ${await response.text()}`)
    }
    return (await response.json()) as { secret: string }
  }

  const connect = async (fields: Record<string, unknown> = {}, scope: unknown[] | null = null) => {
    connection = await createConnection(fields)
    path = `/providers/${connection.id}/v1/chat/completions`
    const scoped = scope === null ? [{ connectionId: connection.id }] : scope
    return await createKey(scoped)
  }

  const chat = (
    token: string | null,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) =>
    iroha.fetch(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...headers,
      },
      body: JSON.stringify(body),
    })

  const completionBody = (model: string = MODEL) => ({
    model,
    messages: [{ role: 'user' as const, content: 'Say hello' }],
    temperature: 0.7,
  })

  describe('Gateway Key authentication and scope', () => {
    test('accepts a valid scoped key', async () => {
      const key = await connect()
      const response = await chat(key.secret, completionBody())

      expect(response.status).toBe(200)
      expect(upstream.calls).toHaveLength(1)
    })

    test('rejects a missing Key with the stable sanitized error', async () => {
      await connect()
      const response = await chat(null, completionBody())

      expect(response.status).toBe(401)
      expect(await openError(response)).toMatchObject({
        error: { code: 'gateway_key_invalid', message: 'This Gateway Key is not valid.' },
      })
      expect(upstream.calls).toHaveLength(0)
    })

    test('rejects a wrong secret exactly like a missing one', async () => {
      await connect()
      const response = await chat('gk_absent.wrong-secret', completionBody())

      expect(response.status).toBe(401)
      expect((await openError(response)).error.code).toBe('gateway_key_invalid')
    })

    test('rejects a revoked key exactly like an unknown one', async () => {
      const key = await connect()

      await iroha.fetch(`/api/v1/admin/gateway-keys/${key.secret.split('.')[0]}/revoke`, {
        method: 'POST',
        csrf,
      })

      const response = await chat(key.secret, completionBody())
      expect(response.status).toBe(401)
      expect((await openError(response)).error.code).toBe('gateway_key_invalid')
    })

    test('rejects a key scoped to a different connection', async () => {
      await connect()
      const other = await createConnection({ displayName: 'Other' })
      const key = await createKey([{ connectionId: other.id }])

      const response = await chat(key.secret, completionBody())

      expect(response.status).toBe(403)
      expect((await openError(response)).error.code).toBe('connection_not_allowed')
      expect(upstream.calls).toHaveLength(0)
    })

    test('rejects a key whose allowed models do not include the request', async () => {
      await connect()
      const key = await createKey([{ connectionId: connection.id, models: [OTHER_MODEL] }])

      const response = await chat(key.secret, completionBody())

      expect(response.status).toBe(403)
      expect((await openError(response)).error.code).toBe('model_not_allowed')
      expect(upstream.calls).toHaveLength(0)
    })

    test('scope restrictions are enforced for unknown models too', async () => {
      await connect()
      const key = await createKey([{ connectionId: connection.id, models: ['gpt-4o'] }])

      const response = await chat(key.secret, completionBody('gpt-3.5-turbo'))

      expect(response.status).toBe(403)
      expect((await openError(response)).error.code).toBe('model_not_allowed')
    })

    test('a key allowing every model on the connection passes any model', async () => {
      const key = await connect()
      const other = await chat(key.secret, completionBody('another-model-id'))

      expect(other.status).toBe(200)
    })
  })

  describe('unchanged forwarding and header boundaries', () => {
    test('forwards the exact request body, unknown fields included', async () => {
      const key = await connect()
      const body = {
        model: MODEL,
        messages: [{ role: 'user', content: 'Say hello' }],
        temperature: 0.7,
        provider_extension: { enabled: true, cost_hint: 0.5 },
      }
      const raw = JSON.stringify(body)

      const response = await iroha.fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key.secret}` },
        body: raw,
      })

      expect(response.status).toBe(200)
      expect(upstream.calls[0]?.body).toBe(raw)
      expect(upstream.calls[0]?.url).toBe(`${BASE_URL}/chat/completions`)
      expect(upstream.calls[0]?.method).toBe('POST')
    })

    test('injects the Upstream Key and never forwards the Gateway Key', async () => {
      const key = await connect()

      await chat(key.secret, completionBody())

      const forwarded = upstream.calls[0]!
      expect(forwarded.headers.authorization).toBe(`Bearer ${UPSTREAM_KEY}`)
      expect(JSON.stringify(forwarded.headers)).not.toContain(key.secret)
    })

    test('strips hop-by-hop, proxy-control, and credential-bearing headers', async () => {
      const key = await connect()

      await chat(key.secret, completionBody(), {
        connection: 'keep-alive',
        cookie: 'session=secret-cookie',
        'x-forwarded-for': '203.0.113.9',
        'x-real-ip': '198.51.100.2',
        'x-request-id': 'caller-chosen-id',
        host: 'evil.example',
        origin: 'https://attacker.example',
        'x-custom-header': 'forward-me',
      })

      const forwarded = upstream.calls[0]!.headers
      for (const blocked of [
        'connection',
        'cookie',
        'x-forwarded-for',
        'x-real-ip',
        'x-request-id',
        'host',
        'origin',
      ]) {
        expect(forwarded[blocked]).toBeUndefined()
      }
      expect(forwarded['authorization']).toBe(`Bearer ${UPSTREAM_KEY}`)
      expect(forwarded['x-custom-header']).toBe('forward-me')
    })
  })

  describe('responses', () => {
    test('returns the upstream success in OpenAI-compatible form', async () => {
      const key = await connect()

      const response = await chat(key.secret, completionBody())
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('application/json')

      const completion = (await response.json()) as {
        id: string
        object: string
        model: string
        choices: { message: { content: string } }[]
      }
      expect(completion.id).toBe('chatcmpl-mock-upstream')
      expect(completion.object).toBe('chat.completion')
      expect(completion.model).toBe(MODEL)
      expect(completion.choices[0]?.message.content).toBe('Mock upstream reply')
    })
  })

  describe('safe upstream failures', () => {
    test('maps common upstream failures to OpenAI-shaped errors with stable codes', async () => {
      const scenarios = [
        { status: 400, code: 'upstream_bad_request' },
        { status: 401, code: 'upstream_invalid_credentials' },
        { status: 403, code: 'upstream_forbidden' },
        { status: 404, code: 'upstream_not_found' },
        { status: 429, code: 'upstream_rate_limited' },
        { status: 500, code: 'upstream_unavailable' },
        { status: 503, code: 'upstream_unavailable' },
      ] as const

      for (const scenario of scenarios) {
        upstream.respondWith(() => new Response('upstream body', { status: scenario.status }))
        const key = await connect()

        const response = await chat(key.secret, completionBody())
        const expectedStatus =
          scenario.status === 401 || scenario.status === 403 || scenario.status === 429
            ? 503
            : scenario.status
        expect(response.status).toBe(expectedStatus)

        const failure = await openError(response)
        expect(failure.error.code).toBe(
          expectedStatus === 503 && scenario.status < 500
            ? 'upstream_credentials_unavailable'
            : scenario.code,
        )
        expect(typeof failure.error.message).toBe('string')
        expect(failure.error.type).toBeDefined()
        expect(response.headers.get('x-request-id')).toMatch(/^req_/)
      }
    })

    test('keeps a numeric Retry-After from a rate-limited upstream', async () => {
      upstream.respondWith(() => new Response('slow down', { status: 429, headers: { 'retry-after': '17' } }))
      const key = await connect()

      const response = await chat(key.secret, completionBody())

      expect(response.status).toBe(503)
      expect(response.headers.get('retry-after')).toBe('17')
      expect((await openError(response)).error.code).toBe('upstream_credentials_unavailable')
    })

    test('drops unusable upstream Retry-After text and returns the bounded fallback', async () => {
      upstream.respondWith(() => new Response('slow down', { status: 429, headers: { 'retry-after': 'soon maybe' } }))
      const key = await connect()

      const response = await chat(key.secret, completionBody())

      expect(response.status).toBe(503)
      expect(response.headers.get('retry-after')).toBe('30')
    })

    test('sanitizes upstream detail and never echoes it', async () => {
      upstream.respondWith(() =>
        new Response(`{"error":"secret text from provider ${UPSTREAM_KEY} leaked"}`, { status: 500 }),
      )
      const key = await connect()

      const response = await chat(key.secret, completionBody())
      const text = await response.text()

      expect(response.status).toBe(500)
      expect(text).not.toContain(UPSTREAM_KEY)
      expect(text).not.toContain('secret text from provider')
      expect((await JSON.parse(text) as { error: { code: string } }).error.code).toBe('upstream_unavailable')
    })

    test('reports an unreachable upstream', async () => {
      upstream.respondWith(() => {
        throw new TypeError('fetch failed')
      })
      const key = await connect()

      const response = await chat(key.secret, completionBody())

      expect(response.status).toBe(502)
      expect((await openError(response)).error.code).toBe('upstream_unreachable')
    })
  })

  describe('the routing-critical envelope', () => {
    test('requires a model', async () => {
      const key = await connect()
      const response = await chat(key.secret, { messages: [{ role: 'user', content: 'hi' }] })

      expect(response.status).toBe(400)
      expect((await openError(response)).error.code).toBe('model_required')
    })

    test('rejects a non-JSON body', async () => {
      const key = await connect()
      const response = await iroha.fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key.secret}` },
        body: '{not json',
      })

      expect(response.status).toBe(400)
      expect((await openError(response)).error.code).toBe('invalid_request')
    })

    test('rejects a non-object body', async () => {
      const key = await connect()
      const response = await chat(key.secret, ['not', 'an', 'object'] as unknown as Record<string, unknown>)

      expect(response.status).toBe(400)
      expect((await openError(response)).error.code).toBe('invalid_request')
    })
  })

  describe('connection state', () => {
    test('reports an archived connection', async () => {
      const key = await connect()
      await iroha.fetch(`/api/v1/admin/provider-connections/${connection.id}/archive`, {
        method: 'POST',
        csrf,
      })

      const response = await chat(key.secret, completionBody())

      expect(response.status).toBe(409)
      expect((await openError(response)).error.code).toBe('connection_archived')
      expect(upstream.calls).toHaveLength(0)
    })

    test('reports a disabled connection', async () => {
      const key = await connect()
      await iroha.fetch(`/api/v1/admin/provider-connections/${connection.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
        csrf,
      })

      const response = await chat(key.secret, completionBody())

      expect(response.status).toBe(409)
      expect((await openError(response)).error.code).toBe('connection_disabled')
      expect(upstream.calls).toHaveLength(0)
    })

    test('reports a purged connection', async () => {
      const key = await connect()
      await iroha.fetch(`/api/v1/admin/provider-connections/${connection.id}/archive`, {
        method: 'POST',
        csrf,
      })
      await iroha.fetch(`/api/v1/admin/provider-connections/${connection.id}/purge`, {
        method: 'POST',
        csrf,
      })

      const response = await chat(key.secret, completionBody())

      expect(response.status).toBe(404)
      expect((await openError(response)).error.code).toBe('connection_not_found')
    })

    test('reports no eligible Upstream Key', async () => {
      const inconclusive = fakeKeyProbe({
        verdict: 'inconclusive',
        reason: 'the provider could not be reached',
      })
      const app = await createTestApp({ upstreamKeyProbe: inconclusive, upstreamTransport: upstream.fetch })
      try {
        const signedIn = await completeSetup(app)
        const response = await app.fetch('/api/v1/admin/provider-connections', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            displayName: 'Untested',
            baseUrl: BASE_URL,
            upstreamKey: UPSTREAM_KEY,
          }),
          csrf: signedIn.csrf,
        })
        const untested = (await response.json()) as ConnectionBody
        expect(untested.keys[0]?.health).toBe('unverified')

        const key = await app.fetch('/api/v1/admin/gateway-keys', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'Untested app',
            scope: [{ connectionId: untested.id }],
          }),
          csrf: signedIn.csrf,
        })
        const { secret } = (await key.json()) as { secret: string }

        const completion = await app.fetch(`/providers/${untested.id}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
          body: JSON.stringify(completionBody()),
        })

        expect(completion.status).toBe(503)
        expect((await openError(completion)).error.code).toBe('upstream_credentials_unavailable')
        expect(upstream.calls).toHaveLength(0)
      } finally {
        await app.dispose()
      }
    })
  })

  describe('correlation', () => {
    test('returns a correlation ID on success and on every refusal', async () => {
      const key = await connect()

      const success = await chat(key.secret, completionBody())
      const missingKey = await chat(null, completionBody())
      const noModel = await chat(key.secret, { messages: [] })

      for (const response of [success, missingKey, noModel]) {
        expect(response.headers.get('x-request-id')).toMatch(/^req_[A-Za-z0-9_-]+$/)
      }
    })

    test('errors carry the correlation ID in their body', async () => {
      const key = await connect()
      const response = await chat('gk_absent.wrong', completionBody())

      const requestId = response.headers.get('x-request-id')
      expect(requestId).not.toBeNull()
      expect((await openError(response)).error.request_id).toBe(requestId ?? undefined)
    })

    test('a caller-supplied request ID is replaced by Iroha', async () => {
      const key = await connect()
      const response = await chat(key.secret, completionBody(), { 'x-request-id': 'caller-chosen' })

      expect(response.headers.get('x-request-id')).toMatch(/^req_/)
      expect(response.headers.get('x-request-id')).not.toBe('caller-chosen')
    })
  })

  describe('cancellation', () => {
    test('caller cancellation aborts the upstream operation', async () => {
      const key = await connect()

      upstream.respondWith(
        (call) =>
          new Promise<Response>((_, reject) => {
            call.signal?.addEventListener('abort', () => {
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            })
          }),
      )

      const controller = new AbortController()
      const pending = iroha.fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key.secret}` },
        body: JSON.stringify(completionBody()),
        signal: controller.signal,
      })

      await until(() => upstream.calls.length > 0)
      expect(upstream.calls[0]?.signal?.aborted).toBe(false)

      controller.abort()
      await expect(pending).resolves.toBeDefined()

      expect(upstream.calls[0]?.signal?.aborted).toBe(true)
    })
  })
})

test('the mock upstream records the body and headers exactly as sent', async () => {
  const upstream = mockUpstreamTransport()
  const call: RecordedUpstreamCall = await new Promise((resolve) => {
    upstream.respondWith((seen) => {
      resolve(seen)
      return new Response('{}')
    })
    upstream.fetch('https://upstream.example/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: '{"a":1}',
    })
  })

  expect(call.url).toBe('https://upstream.example/v1/chat/completions')
  expect(call.method).toBe('POST')
  expect(call.headers.authorization).toBe('Bearer sk-test')
  expect(call.body).toBe('{"a":1}')
  expect(call.signal).toBeNull()
})

async function openError(
  response: Response,
): Promise<{ error: { code: string; message: string; type: string; request_id?: string } }> {
  return (await response.json()) as {
    error: { code: string; message: string; type: string; request_id?: string }
  }
}

async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not reached')
    await Bun.sleep(5)
  }
}
