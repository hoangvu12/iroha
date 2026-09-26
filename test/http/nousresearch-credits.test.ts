import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { completeSetup, createTestApp, type TestApp } from '../support/app.ts'
import { mockUpstreamTransport, type RecordedUpstreamCall } from '../support/inference.ts'

const BASE_URL = 'https://api.example.com/v1'
const MODEL = 'anthropic/claude-opus-5'
const EMPTY_ACCOUNT_KEY = 'sk-no-credits'
const PAID_KEY = 'sk-account-with-credits'

/**
 * The out-of-credit 404 Nous Research answers an account without credits
 * with, exactly as captured in production on 2026-09-26 (message trimmed; the
 * adapter never persists it anyway).
 */
const insufficientCredits = () => Response.json({
  status: 404,
  message: 'Model requires available credits. Your account balance is too low to use paid models.',
  code: 'insufficient_credits_for_paid_model',
}, { status: 404 })

const completion = () => Response.json({
  id: 'chatcmpl-nous',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: MODEL,
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
})

describe('a Nous Research key whose account has no credits', () => {
  // Observed in production: the Provider's single key answered every
  // paid-model Request with 404 insufficient_credits_for_paid_model. The
  // generic 404 reading is request_rejected with a connection_model scope,
  // so the Request failed as `model_keys_unavailable` while the real
  // condition was an empty account.
  let iroha: TestApp
  let upstream: ReturnType<typeof mockUpstreamTransport>
  let csrf: string
  let providerId: string
  let providerHandle: string
  let secret: string

  const chat = () =>
    iroha.fetch(`/providers/${providerHandle}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Hello' }] }),
    })

  const inferencePosts = () => upstream.calls.filter((call) => call.method === 'POST')

  /** First inference Attempt answers with the credits refusal, the rest succeed. */
  const firstAttemptEmpty = (call: RecordedUpstreamCall) => {
    if (call.method !== 'POST') return completion()
    return inferencePosts().length === 1 ? insufficientCredits() : completion()
  }

  /** Runs one Request that lands its first Attempt on the empty key. */
  const chatThatParksTheEmptyKey = async (): Promise<string> => {
    await chat()
    const emptyAuthorization = inferencePosts()[0]?.headers.authorization ?? ''
    expect(inferencePosts()).toHaveLength(2)
    expect(inferencePosts()[1]?.headers.authorization).not.toBe(emptyAuthorization)
    return emptyAuthorization
  }

  beforeEach(async () => {
    upstream = mockUpstreamTransport()
    iroha = await createTestApp({ upstreamTransport: upstream.fetch })
    csrf = (await completeSetup(iroha)).csrf
    const created = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle: crypto.randomUUID(),
        templateId: 'nousresearch',
        displayName: 'Nous Research credits',
        baseUrl: BASE_URL,
        keys: [{ upstreamKey: EMPTY_ACCOUNT_KEY }],
      }),
      csrf,
    })
    const provider = (await created.json()) as { id: string; handle: string }
    providerId = provider.id
    providerHandle = provider.handle
    await iroha.fetch(`/api/v1/admin/providers/${providerId}/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upstreamKey: PAID_KEY }),
      csrf,
    })
    const key = await iroha.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Nous app', scope: [{ providerId }] }),
      csrf,
    })
    secret = ((await key.json()) as { secret: string }).secret
    // The fixture itself reaches the upstream (probes and discovery answer
    // with the default completion); only the assertions' own Attempts are
    // counted after this point.
    upstream.reset()
    upstream.respondWith(firstAttemptEmpty)
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  test('the first Request recovers on the paid sibling and parks the empty key', async () => {
    const response = await chat()

    expect(response.status).toBe(200)
    expect(inferencePosts()).toHaveLength(2)
    expect(inferencePosts()[0]?.headers.authorization)
      .not.toBe(inferencePosts()[1]?.headers.authorization)
    const keys = await iroha.database.providers.listKeys(providerId)
    expect(keys.map((key) => key.health).sort()).toEqual(['active', 'exhausted'])
    const empty = keys.find((key) => key.health === 'exhausted')
    expect(empty).toMatchObject({
      healthScope: 'key',
      healthScopeId: empty?.id,
      retryAfterAt: expect.any(Date),
    })
  })

  test('records why the Attempt failed without retaining the message', async () => {
    const response = await chat()
    const requestId = response.headers.get('x-request-id')!
    const attempts = await iroha.database.requestHistory.getAttempts(requestId)

    expect(attempts[0]?.diagnostics).toMatchObject({
      status: 404,
      providerCode: 'insufficient_credits_for_paid_model',
      classification: 'payment_required',
      capacityScope: 'key',
    })
    expect(JSON.stringify(attempts[0]?.diagnostics)).not.toContain('account balance')
  })

  test('the next Request goes straight to the paid key', async () => {
    const emptyAuthorization = await chatThatParksTheEmptyKey()
    upstream.reset()
    // The empty key is parked exhausted with a future recheck, so only the
    // paid key can answer — and whatever is asked succeeds.
    upstream.respondWith(() => completion())

    const response = await chat()

    expect(response.status).toBe(200)
    expect(inferencePosts()).toHaveLength(1)
    expect(inferencePosts()[0]?.headers.authorization).not.toBe(emptyAuthorization)
  })

  test('a manual key test does not resurrect the parked key', async () => {
    // The probe answers `GET /models` with 2xx even for an account without
    // credits, so the verdict is `authenticated` — authentication only. It
    // must not clear the billing exhaustion, exactly as the reconciliation
    // contract promises.
    const emptyAuthorization = await chatThatParksTheEmptyKey()
    const keys = await iroha.database.providers.listKeys(providerId)
    const empty = keys.find((key) => key.health === 'exhausted')!
    upstream.reset()
    upstream.respondWith(() => Response.json({ object: 'list', data: [] }, { status: 200 }))

    await iroha.fetch(`/api/v1/admin/providers/${providerId}/keys/${empty.id}/test`, {
      method: 'POST',
      csrf,
    })
    const after = (await iroha.database.providers.listKeys(providerId))
      .find((key) => key.id === empty.id)!
    expect(after.health).toBe('exhausted')
    expect(after.lastProbeVerdict).toBe('authenticated')

    upstream.reset()
    upstream.respondWith(() => completion())
    const response = await chat()

    expect(response.status).toBe(200)
    expect(inferencePosts()).toHaveLength(1)
    expect(inferencePosts()[0]?.headers.authorization).not.toBe(emptyAuthorization)
  })
})
