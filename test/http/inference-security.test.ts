import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  completeSetup,
  createTestApp,
  ORIGIN,
  type TestApp,
} from '../support/app.ts'
import {
  controlledSse,
  mockUpstreamTransport,
  sseDone,
  sseEvent,
} from '../support/inference.ts'
import { fakeTimer, type FakeTimer } from '../support/timer.ts'

const UPSTREAM_KEY = 'sk-upstream-secret-value-for-tests'
const BASE_URL = 'https://api.example.com/v1'
const MODEL = 'gpt-4o-mini'

async function readAllStream(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (body === null) return ''
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let received = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    received += decoder.decode(value)
  }
  return received
}

function chunk(): string {
  return JSON.stringify({
    id: 'chatcmpl-stream-test',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: MODEL,
    choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
  })
}

interface ConnectionBody {
  id: string
  displayName: string
  keys: { id: string; health: string }[]
}

async function createConnection(
  iroha: TestApp,
  csrf: string,
  fields: Record<string, unknown> = {},
): Promise<ConnectionBody> {
  const response = await iroha.fetch('/api/v1/admin/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      displayName: 'Security example',
      baseUrl: BASE_URL,
      keys: [{ upstreamKey: UPSTREAM_KEY }],
      ...fields,
    }),
    csrf,
  })
  if (response.status !== 201) {
    throw new Error(`Connection create failed: ${response.status}: ${await response.text()}`)
  }
  return (await response.json()) as ConnectionBody
}

async function createKey(
  iroha: TestApp,
  csrf: string,
  scope: readonly { providerId: string }[],
): Promise<{ id: string; secret: string }> {
  const response = await iroha.fetch('/api/v1/admin/gateway-keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'App credential', scope }),
    csrf,
  })
  if (response.status !== 201) {
    throw new Error(`Key create failed: ${response.status}: ${await response.text()}`)
  }
  return (await response.json()) as { id: string; secret: string }
}

describe('provider transport security boundaries', () => {
  let iroha: TestApp
  let csrf: string
  let upstream: ReturnType<typeof mockUpstreamTransport>
  let connection: ConnectionBody
  let path: string
  let secret: string

  beforeEach(async () => {
    upstream = mockUpstreamTransport()
    iroha = await createTestApp({ upstreamTransport: upstream.fetch })
    csrf = (await completeSetup(iroha)).csrf
    connection = await createConnection(iroha, csrf)
    path = `/providers/${connection.id}/v1/chat/completions`
    const key = await createKey(iroha, csrf, [{ providerId: connection.id }])
    secret = key.secret
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  const chat = (
    headers: Record<string, string> = {},
    body: Record<string, unknown> = {
      model: MODEL,
      messages: [{ role: 'user', content: 'Say hello' }],
    },
  ) =>
    iroha.fetch(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
        ...headers,
      },
      body: JSON.stringify(body),
    })

  test('callers cannot redirect the upstream destination through headers', async () => {
    await chat({
      host: 'evil.example',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'http',
      'x-forwarded-for': '203.0.113.9',
    })

    expect(upstream.calls).toHaveLength(1)
    const forwarded = upstream.calls[0]!.headers
    expect(forwarded['host']).toBeUndefined()
    expect(forwarded['x-forwarded-host']).toBeUndefined()
    expect(forwarded['x-forwarded-proto']).toBeUndefined()
    expect(forwarded['x-forwarded-for']).toBeUndefined()
    expect(upstream.calls[0]!.url.startsWith(BASE_URL)).toBe(true)
  })

  test('callers cannot smuggle an alternative authorization header', async () => {
    await chat({
      cookie: 'session=attacker-cookie-value',
      'x-real-ip': '198.51.100.99',
    })

    const forwarded = upstream.calls[0]!.headers
    expect(forwarded['authorization']).toBe(`Bearer ${UPSTREAM_KEY}`)
    expect(forwarded['cookie']).toBeUndefined()
    expect(forwarded['x-real-ip']).toBeUndefined()
    expect(JSON.stringify(forwarded)).not.toContain('attacker-cookie-value')
  })

  test('callers cannot override the static headers configured on the connection', async () => {
    const created = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Static headers',
        baseUrl: BASE_URL,
        keys: [{ upstreamKey: UPSTREAM_KEY }],
        staticHeaders: [{ name: 'X-Provider-Flag', value: 'enabled-by-owner' }],
      }),
      csrf,
    })
    if (created.status !== 201) {
      throw new Error(`Create failed: ${created.status}: ${await created.text()}`)
    }
    const created2 = (await created.json()) as ConnectionBody
    const key = await createKey(iroha, csrf, [{ providerId: created2.id }])
    const localSecret = key.secret

    await iroha.fetch(`/providers/${created2.id}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${localSecret}`,
        'x-provider-flag': 'caller-overrode',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    })

    const forwarded = upstream.calls[0]!.headers
    expect(forwarded['x-provider-flag']).toBe('enabled-by-owner')
  })

  test('a redirect to a cross-origin host returns 502 and never leaks the upstream key', async () => {
    upstream.respondWith(() =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://attacker.example/steal' },
      }),
    )

    const response = await chat()

    expect(response.status).toBe(502)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('upstream_redirect')
    const calls = upstream.calls
    expect(calls.every((call) => call.url.startsWith(BASE_URL))).toBe(true)
    expect(calls.every((call) => !call.url.includes('attacker.example'))).toBe(true)
  })

  test('a connection with the redirect flag off sees the redirect mapped to upstream unreachable', async () => {
    upstream.respondWith(() =>
      new Response(null, {
        status: 302,
        headers: { location: `${BASE_URL}/v2/chat/completions` },
      }),
    )

    const response = await chat()

    expect(response.status).toBe(502)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('upstream_redirect')
    expect(upstream.calls).toHaveLength(1)
  })

  test('a same-origin redirect follows the Location without leaking credentials to a different host', async () => {
    upstream.respondWith((call) => {
      if (call.url === `${BASE_URL}/chat/completions`) {
        return new Response(null, {
          status: 302,
          headers: { location: `${BASE_URL}/v1/chat/completions` },
        })
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    await iroha.dispose()
    iroha = await createTestApp({ upstreamTransport: upstream.fetch })
    csrf = (await completeSetup(iroha)).csrf
    const created = await createConnection(iroha, csrf, { redirectAllowSameOrigin: true })
    path = `/providers/${created.id}/v1/chat/completions`
    const key = await createKey(iroha, csrf, [{ providerId: created.id }])
    secret = key.secret

    await chat()

    const visited = upstream.calls.map((call) => call.url)
    expect(visited).toContain(`${BASE_URL}/v1/chat/completions`)
    for (const call of upstream.calls) {
      expect(call.headers['authorization']).toBe(`Bearer ${UPSTREAM_KEY}`)
      expect(call.url.includes('attacker.example')).toBe(false)
    }
  })

  test('caller-supplied idempotency header is forwarded verbatim to the upstream', async () => {
    const callerKey = 'caller-supplied-idem-key-001'

    await chat({ 'idempotency-key': callerKey })

    const forwarded = upstream.calls[0]!.headers
    expect(forwarded['idempotency-key']).toBe(callerKey)
  })

  test('when the caller does not send an idempotency header, the adapter mints one', async () => {
    await chat()

    const forwarded = upstream.calls[0]!.headers
    expect(forwarded['idempotency-key']).toBeDefined()
    expect(typeof forwarded['idempotency-key']).toBe('string')
    expect((forwarded['idempotency-key'] as string).length).toBeGreaterThan(0)
  })

  test('a redacted Upstream Key value never appears in error responses or audit history', async () => {
    upstream.respondWith(() =>
      new Response(`upstream saw headers including ${UPSTREAM_KEY}`, { status: 502 }),
    )

    const response = await chat()

    expect(response.status).toBeGreaterThanOrEqual(400)
    const text = await response.text()
    expect(text).not.toContain(UPSTREAM_KEY)

    const audit = await iroha.database.audit.list()
    for (const record of audit) {
      expect(JSON.stringify(record)).not.toContain(UPSTREAM_KEY)
    }
  })
})

describe('CORS behavior for inference', () => {
  let iroha: TestApp
  let csrf: string
  let upstream: ReturnType<typeof mockUpstreamTransport>
  let connection: ConnectionBody
  let path: string
  let secret: string

  beforeEach(async () => {
    upstream = mockUpstreamTransport()
    iroha = await createTestApp({ upstreamTransport: upstream.fetch })
    csrf = (await completeSetup(iroha)).csrf
    connection = await createConnection(iroha, csrf)
    path = `/providers/${connection.id}/v1/chat/completions`
    const key = await createKey(iroha, csrf, [{ providerId: connection.id }])
    secret = key.secret
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  test('cross-origin requests from a non-allow-listed origin are denied without invoking the upstream', async () => {
    const response = await iroha.fetch(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
        origin: 'https://attacker.example',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    })

    expect(response.status).toBe(403)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('cors_origin_denied')
    expect(upstream.calls).toHaveLength(0)
  })

  test('a same-origin request never carries CORS response headers', async () => {
    const response = await iroha.fetch(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
        origin: ORIGIN,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  test('a global allow-list entry returns the right CORS headers and reaches the upstream', async () => {
    await iroha.dispose()
    upstream = mockUpstreamTransport()
    iroha = await createTestApp({
      upstreamTransport: upstream.fetch,
      transportDefaults: {
        connectionTimeoutMs: 5_000,
        firstByteTimeoutMs: 5_000,
        nonStreamingTotalTimeoutMs: 10_000,
        streamingIdleTimeoutMs: 5_000,
        totalRetryTimeoutMs: 10_000,
        corsAllowedOrigins: ['https://allowed.example'],
      },
    })
    csrf = (await completeSetup(iroha)).csrf
    connection = await createConnection(iroha, csrf)
    path = `/providers/${connection.id}/v1/chat/completions`
    const key = await createKey(iroha, csrf, [{ providerId: connection.id }])
    secret = key.secret

    const response = await iroha.fetch(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
        origin: 'https://allowed.example',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://allowed.example')
    expect(upstream.calls).toHaveLength(1)
  })

  test('a per-Gateway-Key allow-list entry returns the right CORS headers', async () => {
    await iroha.dispose()
    upstream = mockUpstreamTransport()
    iroha = await createTestApp({ upstreamTransport: upstream.fetch })
    csrf = (await completeSetup(iroha)).csrf
    connection = await createConnection(iroha, csrf)
    path = `/providers/${connection.id}/v1/chat/completions`
    const keyResponse = await iroha.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Browser app',
        scope: [{ providerId: connection.id }],
        corsOrigins: ['https://browser.example'],
      }),
      csrf,
    })
    if (keyResponse.status !== 201) {
      throw new Error(`Key create failed: ${keyResponse.status}: ${await keyResponse.text()}`)
    }
    const key = (await keyResponse.json()) as { id: string; secret: string; revision: number; access: { mode: 'selected'; providers: unknown[] } }
    secret = key.secret

    const response = await iroha.fetch(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
        origin: 'https://browser.example',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://browser.example')

    const edited = await iroha.fetch(`/api/v1/admin/gateway-keys/${key.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revision: key.revision, name: 'Browser app', access: key.access, corsOrigins: ['https://new-browser.example'] }),
      csrf,
    })
    expect(edited.status).toBe(200)
    const oldOrigin = await iroha.fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}`, origin: 'https://browser.example' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Hello' }] }),
    })
    expect(oldOrigin.status).toBe(403)
    const newOrigin = await iroha.fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}`, origin: 'https://new-browser.example' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Hello' }] }),
    })
    expect(newOrigin.status).toBe(200)
    expect(newOrigin.headers.get('access-control-allow-origin')).toBe('https://new-browser.example')
  })

  test('a CORS preflight replies with the allow-listed origin and the right methods', async () => {
    await iroha.dispose()
    upstream = mockUpstreamTransport()
    iroha = await createTestApp({
      upstreamTransport: upstream.fetch,
      transportDefaults: {
        connectionTimeoutMs: 5_000,
        firstByteTimeoutMs: 5_000,
        nonStreamingTotalTimeoutMs: 10_000,
        streamingIdleTimeoutMs: 5_000,
        totalRetryTimeoutMs: 10_000,
        corsAllowedOrigins: ['https://allowed.example'],
      },
    })
    csrf = (await completeSetup(iroha)).csrf
    connection = await createConnection(iroha, csrf)
    path = `/providers/${connection.id}/v1/chat/completions`

    const preflight = await iroha.fetch(path, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://allowed.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    })

    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://allowed.example')
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST')
    expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization')
    expect(upstream.calls).toHaveLength(0)
  })

  test('wildcard origins are rejected when supplied via Gateway Key configuration', async () => {
    const response = await iroha.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Wildcard attempt',
        scope: [{ providerId: connection.id }],
        corsOrigins: ['*'],
      }),
      csrf,
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('validation_failed')
  })
})

describe('advanced transport configuration validation', () => {
  let iroha: TestApp
  let csrf: string

  beforeEach(async () => {
    const setupUpstream = mockUpstreamTransport()
    iroha = await createTestApp({ upstreamTransport: setupUpstream.fetch })
    csrf = (await completeSetup(iroha)).csrf
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  test('rejects an unknown authentication header name', async () => {
    const response = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Bad auth header',
        baseUrl: BASE_URL,
        keys: [{ upstreamKey: UPSTREAM_KEY }],
        authHeader: 'Authorization\r\nX-Evil-Header: pwned',
      }),
      csrf,
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('validation_failed')
  })

  test('accepts a canonical custom authentication header name', async () => {
    const response = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Custom auth header',
        baseUrl: BASE_URL,
        keys: [{ upstreamKey: UPSTREAM_KEY }],
        authHeader: 'X-Custom-Auth',
        authPrefix: 'Token ',
      }),
      csrf,
    })

    expect(response.status).toBe(201)
  })

  test('rejects an authentication prefix containing control characters', async () => {
    const response = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Bad auth prefix',
        baseUrl: BASE_URL,
        keys: [{ upstreamKey: UPSTREAM_KEY }],
        authPrefix: 'Bearer \r\nX-Evil: yes',
      }),
      csrf,
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('validation_failed')
  })

  test('rejects a timeout value below the minimum', async () => {
    const response = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Tiny timeout',
        baseUrl: BASE_URL,
        keys: [{ upstreamKey: UPSTREAM_KEY }],
        connectionTimeoutMs: 10,
      }),
      csrf,
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('validation_failed')
  })

  test('rejects an HTTP base URL when the explicit allow flag is not set', async () => {
    const response = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Plain HTTP',
        baseUrl: 'http://api.example.com/v1',
        keys: [{ upstreamKey: UPSTREAM_KEY }],
      }),
      csrf,
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('validation_failed')
  })

  test('accepts an explicit insecure HTTP connection and surfaces the warning', async () => {
    const response = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Local vLLM',
        baseUrl: 'http://localhost:8000/v1',
        keys: [{ upstreamKey: UPSTREAM_KEY }],
        allowInsecureHttp: true,
      }),
      csrf,
    })

    expect(response.status).toBe(201)
    const body = (await response.json()) as { warnings: string[] }
    expect(body.warnings).toContain('insecure_http')
  })

  test('static headers are encrypted at rest and only their names are visible', async () => {
    const created = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Static headers',
        baseUrl: BASE_URL,
        keys: [{ upstreamKey: UPSTREAM_KEY }],
        staticHeaders: [{ name: 'X-Trace-Id', value: 'plaintext-secret-value' }],
      }),
      csrf,
    })
    expect(created.status).toBe(201)
    const created2 = (await created.json()) as ConnectionBody & {
      staticHeaders: { name: string }[]
    }
    expect(created2.staticHeaders.map((h) => h.name)).toEqual(['X-Trace-Id'])

    const row = await iroha.database.providers.getProvider(created2.id)
    expect(row?.staticHeadersEncrypted).not.toContain('plaintext-secret-value')
  })
})

describe('per-connection transport overrides reach the runtime', () => {
  let iroha: TestApp
  let csrf: string
  let upstream: ReturnType<typeof mockUpstreamTransport>
  let timer: FakeTimer
  let providerId: string
  let secret: string
  let path: string

  beforeEach(async () => {
    upstream = mockUpstreamTransport()
    timer = fakeTimer()
    // No route-level streaming override: the per-connection override should
    // be the one that fires. The global transport default is 30s so we need
    // a per-connection value well below that.
    iroha = await createTestApp({
      upstreamTransport: upstream.fetch,
      timer,
    })
    csrf = (await completeSetup(iroha)).csrf
    const created = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Streaming override',
        baseUrl: BASE_URL,
        keys: [{ upstreamKey: UPSTREAM_KEY }],
        streamingIdleTimeoutMs: 1_500,
      }),
      csrf,
    })
    if (created.status !== 201) {
      throw new Error(`Create failed: ${created.status}: ${await created.text()}`)
    }
    providerId = ((await created.json()) as ConnectionBody).id
    const key = await iroha.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'App', scope: [{ providerId }] }),
      csrf,
    })
    if (key.status !== 201) {
      throw new Error(`Key create failed: ${key.status}: ${await key.text()}`)
    }
    secret = ((await key.json()) as { secret: string }).secret
    path = `/providers/${providerId}/v1/chat/completions`
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  const streamChat = () =>
    iroha.fetch(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    })

  test('the per-connection streaming idle override aborts the stream before the route-level default', async () => {
    upstream.respondWith((call) => {
      const held = controlledSse(call)
      held.enqueue(sseEvent(chunk()))
      return new Response(held.stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const baseline = upstream.calls.length

    const response = await streamChat()
    expect(response.status).toBe(200)

    const reading = readAllStream(response.body)
    // The per-connection override (1_500ms) is well below the route default
    // (30_000ms). Advancing only 5_000ms past the chunk must fire the idle
    // deadline, which the route default alone would not.
    timer.advance(5_000)
    timer.flush()

    const received = await reading
    expect(received).toBe(sseEvent(chunk()))
    expect(upstream.calls[baseline]?.signal?.aborted).toBe(true)
    expect(upstream.calls.length - baseline).toBe(1)
  })
})
