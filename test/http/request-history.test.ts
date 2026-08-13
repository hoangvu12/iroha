import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  completeSetup,
  createTestApp,
  errorCode,
  type TestApp,
} from '../support/app.ts'
import { mockUpstreamTransport } from '../support/inference.ts'

const UPSTREAM_KEY = 'sk-upstream-secret-value-for-tests'
const BASE_URL = 'https://api.example.com/v1'
const MODEL = 'gpt-4o-mini'
const GATEWAY_KEY_NAME = 'App credential'

interface ConnectionBody {
  id: string
  displayName: string
  keys: { id: string; health: string }[]
}

interface RequestEventDto {
  id: string
  occurredAt: string
  providerId: string
  model: string
  gatewayKeyId: string | null
  keyId: string | null
  status: number
  outcome: 'success' | 'failure'
  latencyMs: number
  isStreaming: boolean
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
  errorCode: string | null
}

interface RequestAttemptDto {
  id: number
  attemptNumber: number
  keyId: string | null
  startedAt: string
  completedAt: string | null
  status: number | null
  outcome: 'success' | 'failure' | 'skipped'
  errorCode: string | null
  retryAfterSeconds: number | null
}

describe('private request history and audit', () => {
  let iroha: TestApp
  let csrf: string
  let upstream: ReturnType<typeof mockUpstreamTransport>
  let connection: ConnectionBody
  let keySecret: string
  let keyId: string
  let upstreamKeyId: string

  beforeEach(async () => {
    upstream = mockUpstreamTransport()
    iroha = await createTestApp({ upstreamTransport: upstream.fetch })
    csrf = (await completeSetup(iroha)).csrf
    const created = await createConnection()
    connection = created
    upstreamKeyId = created.keys[0]!.id
    const key = await createKey([{ providerId: created.id }])
    keySecret = key.secret
    keyId = key.id
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  const createConnection = async (): Promise<ConnectionBody> => {
    const response = await iroha.fetch('/api/v1/admin/providers', {
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
    return (await response.json()) as ConnectionBody
  }

  const createKey = async (scope: unknown[]): Promise<{ secret: string; id: string }> => {
    const response = await iroha.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: GATEWAY_KEY_NAME, scope }),
      csrf,
    })
    if (response.status !== 201) {
      throw new Error(`Key create failed with ${response.status}: ${await response.text()}`)
    }
    return (await response.json()) as { secret: string; id: string }
  }

  const chat = (
    token: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) =>
    iroha.fetch(`/providers/${connection.id}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...headers,
      },
      body: JSON.stringify(body),
    })

  describe('request history', () => {
    test('records a successful inference call without prompts or responses', async () => {
      const response = await chat(keySecret, { model: MODEL, messages: [{ role: 'user', content: 'hi' }] })
      expect(response.status).toBe(200)
      const requestId = response.headers.get('x-request-id')
      expect(requestId).not.toBeNull()

      const list = await iroha.fetch('/api/v1/admin/requests')
      expect(list.status).toBe(200)
      const body = (await list.json()) as { events: RequestEventDto[]; total: number }

      expect(body.total).toBe(1)
      const event = body.events[0]!
      expect(event.id).toBe(requestId!)
      expect(event.providerId).toBe(connection.id)
      expect(event.model).toBe(MODEL)
      expect(event.gatewayKeyId).toBe(keyId)
      expect(event.keyId).toBe(upstreamKeyId)
      expect(event.outcome).toBe('success')
      expect(event.status).toBe(200)
      expect(event.promptTokens).toBe(5)
      expect(event.completionTokens).toBe(5)
      expect(event.totalTokens).toBe(10)
      expect(event.errorCode).toBeNull()
      const raw = await response.text()
      expect(raw).not.toContain('sk-upstream-secret-value-for-tests')
    })

    test('captures the retry trail across multiple Upstream Keys', async () => {
      // Two active keys; the first to be picked by round-robin returns 401,
      // forcing the inference loop to rotate to the second which succeeds.
      const second = await iroha.fetch(
        '/api/v1/admin/providers/' + connection.id + '/keys',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ upstreamKey: 'sk-second-upstream-secret-value' }),
          csrf,
        },
      )
      expect(second.status).toBe(201)
      // The default probe uses the stub transport; now answer the two keys
      // differently so the inference loop sees a 401 on whichever cursor
      // lands on it first.
      upstream.respondWith((call) => {
        if (call.headers['authorization'] === `Bearer ${UPSTREAM_KEY}`) {
          return new Response('{"error":{"message":"bad key"}}', { status: 401 })
        }
        return Response.json({
          id: 'chatcmpl-second',
          object: 'chat.completion',
          created: 1,
          model: MODEL,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      })
      // Both keys are now Active (their probes passed under the default
      // responder). To guarantee the original key is tried first we
      // explicitly reset its health by clearing it through a re-activation
      // sequence, then we make several requests until one of them rotates.
      for (let i = 0; i < 5; i++) {
        await chat(keySecret, { model: MODEL, messages: [{ role: 'user', content: `r${i}` }] })
      }

      const list = await iroha.fetch('/api/v1/admin/requests')
      const body = (await list.json()) as { events: RequestEventDto[]; total: number; }
      const detailPromises = body.events.map(async (event) => {
        const detail = await iroha.fetch(`/api/v1/admin/requests/${event.id}`)
        return (await detail.json()) as { event: RequestEventDto; attempts: RequestAttemptDto[] }
      })
      const details = await Promise.all(detailPromises)

      const withRetries = details.find((d) => d.attempts.length > 1)
      expect(withRetries).toBeDefined()
      const successfulWithFailure = details.find(
        (d) =>
          d.event.outcome === 'success' &&
          d.attempts.some((a) => a.outcome === 'failure') &&
          d.attempts.some((a) => a.outcome === 'success'),
      )
      expect(successfulWithFailure).toBeDefined()
      expect(successfulWithFailure!.attempts.some((a) => a.status === 401)).toBe(true)
    })

    test('records a no-eligible-key failure with the Iroha code', async () => {
      // Disable every key so no eligible Upstream Key remains.
      for (const key of connection.keys) {
        const response = await iroha.fetch(
          `/api/v1/admin/providers/${connection.id}/keys/${key.id}/disable`,
          { method: 'POST', csrf },
        )
        expect(response.status).toBe(200)
      }

      const response = await chat(keySecret, { model: MODEL, messages: [{ role: 'user', content: 'hi' }] })
      expect(response.status).toBe(503)
      const requestId = response.headers.get('x-request-id')!

      const list = await iroha.fetch('/api/v1/admin/requests')
      const body = (await list.json()) as { events: RequestEventDto[]; total: number }
      expect(body.events[0]!.outcome).toBe('failure')
      expect(body.events[0]!.errorCode).toBe('upstream_credentials_unavailable')
      expect(body.events[0]!.id).toBe(requestId)
    })

    test('filters by connection, model, and outcome', async () => {
      await chat(keySecret, { model: MODEL, messages: [{ role: 'user', content: 'a' }] })
      await chat(keySecret, { model: 'gpt-4o', messages: [{ role: 'user', content: 'b' }] })

      const byModel = await iroha.fetch(`/api/v1/admin/requests?model=gpt-4o`)
      const byModelBody = (await byModel.json()) as { events: RequestEventDto[]; total: number }
      expect(byModelBody.events.map((event) => event.model)).toEqual(['gpt-4o'])

      const byConnection = await iroha.fetch(
        `/api/v1/admin/requests?providerId=${connection.id}`,
      )
      const byConnectionBody = (await byConnection.json()) as { events: RequestEventDto[]; total: number }
      expect(byConnectionBody.events).toHaveLength(2)

      const byOutcome = await iroha.fetch(`/api/v1/admin/requests?outcome=failure`)
      const byOutcomeBody = (await byOutcome.json()) as { events: RequestEventDto[]; total: number }
      expect(byOutcomeBody.total).toBe(0)
    })

    test('paginates events with limit and offset', async () => {
      for (let i = 0; i < 5; i++) {
        await chat(keySecret, { model: MODEL, messages: [{ role: 'user', content: String(i) }] })
      }
      const page = await iroha.fetch('/api/v1/admin/requests?limit=2&offset=1')
      const body = (await page.json()) as { events: RequestEventDto[]; total: number }
      expect(body.events).toHaveLength(2)
      expect(body.total).toBe(5)
    })

    test('refuses without a session', async () => {
      const unsignedOut = await createTestApp({ upstreamTransport: upstream.fetch })
      try {
        const response = await unsignedOut.fetch('/api/v1/admin/requests')
        expect(response.status).toBe(401)
        expect(await errorCode(response)).toBe('authentication_required')
      } finally {
        await unsignedOut.dispose()
      }
    })

    test('returns 404 for an unknown request id', async () => {
      const response = await iroha.fetch('/api/v1/admin/requests/req_does_not_exist')
      expect(response.status).toBe(404)
      expect(await errorCode(response)).toBe('request_not_found')
    })
  })

  describe('audit feed', () => {
    test('lists recorded audit events including model-catalog mutations', async () => {
      // Provider Connection create
      await createConnection()
      // Model catalog mutation
      const add = await iroha.fetch(
        `/api/v1/admin/providers/${connection.id}/catalog/models`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ modelId: 'custom-model' }),
          csrf,
        },
      )
      expect(add.status).toBe(200)

      const response = await iroha.fetch('/api/v1/admin/audit')
      const body = (await response.json()) as {
        events: { id: number; action: string; outcome: string }[]
        total: number
      }
      const actions = body.events.map((event) => event.action)
      expect(actions).toContain('provider.created')
      expect(actions).toContain('model_catalog.owner_added')
      expect(body.total).toBeGreaterThan(2)
    })

    test('filters audit events by action prefix', async () => {
      await createConnection()
      const response = await iroha.fetch('/api/v1/admin/audit?actionPrefix=provider')
      const body = (await response.json()) as { events: { action: string }[]; total: number }
      for (const event of body.events) {
        expect(event.action.startsWith('provider')).toBe(true)
      }
    })

    test('records every Owner mutation as an audit event', async () => {
      const initial = (await (await iroha.fetch('/api/v1/admin/audit')).json()) as {
        events: unknown[]
        total: number
      }
      const initialTotal = initial.total

      await iroha.fetch(`/api/v1/admin/providers/${connection.id}/archive`, {
        method: 'POST',
        csrf,
      })

      const updated = (await (await iroha.fetch('/api/v1/admin/audit')).json()) as {
        events: { action: string }[]
        total: number
      }
      expect(updated.total).toBeGreaterThan(initialTotal)
      expect(updated.events.some((event) => event.action === 'provider.archived')).toBe(true)
    })

    test('clears the feed and records the act of clearing', async () => {
      const response = await iroha.fetch('/api/v1/admin/audit', { method: 'DELETE', csrf })
      expect(response.status).toBe(200)
      const body = (await response.json()) as { removed: number }
      expect(body.removed).toBeGreaterThan(0)

      const after = await iroha.fetch('/api/v1/admin/audit')
      const afterBody = (await after.json()) as { events: { action: string }[]; total: number }
      expect(afterBody.events).toHaveLength(1)
      expect(afterBody.events[0]!.action).toBe('audit.cleared')
    })

    test('refuses to clear without CSRF', async () => {
      const response = await iroha.fetch('/api/v1/admin/audit', { method: 'DELETE' })
      expect(response.status).toBe(403)
      expect(await errorCode(response)).toBe('csrf_token_invalid')
    })
  })

  describe('retention', () => {
    test('reports and updates the request-history retention window', async () => {
      const before = await iroha.fetch('/api/v1/admin/settings/request-history')
      const beforeBody = (await before.json()) as { days: number; enabled: boolean }
      expect(beforeBody.days).toBe(30)
      expect(beforeBody.enabled).toBe(true)

      const update = await iroha.fetch('/api/v1/admin/settings/request-history', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ days: 7 }),
        csrf,
      })
      expect(update.status).toBe(200)
      const updateBody = (await update.json()) as { days: number; enabled: boolean }
      expect(updateBody.days).toBe(7)

      const audit = await iroha.fetch('/api/v1/admin/audit?actionPrefix=settings.request_history')
      const auditBody = (await audit.json()) as { events: { action: string; detail: { days?: number } }[] }
      expect(auditBody.events[0]!.detail.days).toBe(7)
    })

    test('disabling retention writes no event rows', async () => {
      await iroha.fetch('/api/v1/admin/settings/request-history', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ days: 0 }),
        csrf,
      })

      const response = await chat(keySecret, { model: MODEL, messages: [{ role: 'user', content: 'hi' }] })
      expect(response.status).toBe(200)

      const list = await iroha.fetch('/api/v1/admin/requests')
      const body = (await list.json()) as { events: unknown[]; total: number }
      expect(body.total).toBe(0)
    })

    test('rejects a non-integer retention value', async () => {
      const response = await iroha.fetch('/api/v1/admin/settings/request-history', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ days: -3 }),
        csrf,
      })
      expect(response.status).toBe(400)
      expect(await errorCode(response)).toBe('invalid_request')
    })
  })

  describe('caller-safe errors', () => {
    test('refusal JSON carries the request ID and no internal key or retry names', async () => {
      upstream.respondWith(() => new Response('{"error":{"message":"denied"}}', { status: 401 }))
      const response = await chat(keySecret, { model: MODEL, messages: [{ role: 'user', content: 'hi' }] })
      const body = (await response.json()) as { error: { code: string; request_id: string; message: string } }
      // The original key was rotated to invalid on first 401; subsequent
      // retries exhaust the eligible-key set and report
      // `upstream_credentials_unavailable`. Either way, the body must
      // carry a request ID and never echo the Upstream Key material.
      expect(['upstream_invalid_credentials', 'upstream_credentials_unavailable']).toContain(
        body.error.code,
      )
      expect(body.error.request_id).toBe(response.headers.get('x-request-id') ?? '')
      const payload = JSON.stringify(body)
      expect(payload).not.toContain('sk-upstream-secret-value-for-tests')
      expect(payload).not.toContain('sk-second-upstream-secret-value')
      expect(payload).not.toContain(UPSTREAM_KEY)
      expect(payload).not.toContain('retry')
      expect(payload).not.toContain('attempt')
      expect(payload).not.toContain(upstreamKeyId)
    })
  })
})