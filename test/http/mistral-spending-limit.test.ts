import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { completeSetup, createTestApp, type TestApp } from '../support/app.ts'
import { mockUpstreamTransport, type RecordedUpstreamCall } from '../support/inference.ts'

const BASE_URL = 'https://api.example.com/v1'
const MODEL = 'mistral-small-latest'
const CAPPED_KEY = 'sk-capped-spending-limit'
const HEALTHY_KEY = 'sk-healthy-mistral-key'

/**
 * The billing 402 Mistral answers a spending-capped key with, exactly as
 * captured in production on 2026-09-26 (message trimmed; the adapter never
 * persists it anyway).
 */
const spendingLimitReached = () => Response.json({
  object: 'error',
  message: 'Customer monthly spending limit reached. Increase your limit to restore access.',
  type: 'billing_customer_monthly_spending_limit_reached',
  param: null,
  code: '2300',
  raw_status_code: 402,
}, { status: 402 })

const completion = () => Response.json({
  id: 'chatcmpl-mistral',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: MODEL,
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
})

describe('a Mistral key whose customer spending limit is reached', () => {
  // Observed in production: one of the Provider's two keys answered the
  // documented billing 402 on every inference. The generic reading asserts no
  // capacity, so the key stayed `active` and burned the first Attempt of
  // every Request — three in a row at 2026-09-26T22:29Z — before the healthy
  // sibling recovered each one.
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

  /** First inference Attempt answers with the billing refusal, the rest succeed. */
  const firstAttemptCapped = (call: RecordedUpstreamCall) => {
    if (call.method !== 'POST') return completion()
    return inferencePosts().length === 1 ? spendingLimitReached() : completion()
  }

  /** Runs one Request that lands its first Attempt on the capped key. */
  const chatThatParksTheCappedKey = async (): Promise<string> => {
    await chat()
    const cappedAuthorization = inferencePosts()[0]?.headers.authorization ?? ''
    expect(inferencePosts()).toHaveLength(2)
    expect(inferencePosts()[1]?.headers.authorization).not.toBe(cappedAuthorization)
    return cappedAuthorization
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
        templateId: 'mistral',
        displayName: 'Mistral spending cap',
        baseUrl: BASE_URL,
        keys: [{ upstreamKey: CAPPED_KEY }],
      }),
      csrf,
    })
    const provider = (await created.json()) as { id: string; handle: string }
    providerId = provider.id
    providerHandle = provider.handle
    await iroha.fetch(`/api/v1/admin/providers/${providerId}/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upstreamKey: HEALTHY_KEY }),
      csrf,
    })
    const key = await iroha.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Mistral app', scope: [{ providerId }] }),
      csrf,
    })
    secret = ((await key.json()) as { secret: string }).secret
    // The fixture itself reaches the upstream (probes and discovery answer
    // with the default completion); only the assertions' own Attempts are
    // counted after this point.
    upstream.reset()
    upstream.respondWith(firstAttemptCapped)
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  test('the first Request recovers on the healthy sibling and parks the capped key', async () => {
    const response = await chat()

    expect(response.status).toBe(200)
    expect(inferencePosts()).toHaveLength(2)
    const cappedAuthorization = inferencePosts()[0]?.headers.authorization!
    expect(inferencePosts()[1]?.headers.authorization).not.toBe(cappedAuthorization)
    const keys = await iroha.database.providers.listKeys(providerId)
    expect(keys.map((key) => key.health).sort()).toEqual(['active', 'exhausted'])
    const capped = keys.find((key) => key.health === 'exhausted')
    expect(capped).toMatchObject({
      healthScope: 'key',
      healthScopeId: capped?.id,
      retryAfterAt: expect.any(Date),
    })
  })

  test('records why the Attempt failed without retaining the message', async () => {
    const response = await chat()
    const requestId = response.headers.get('x-request-id')!
    const attempts = await iroha.database.requestHistory.getAttempts(requestId)

    expect(attempts[0]?.diagnostics).toMatchObject({
      status: 402,
      providerCode: '2300',
      providerType: 'billing_customer_monthly_spending_limit_reached',
      classification: 'payment_required',
      capacityScope: 'key',
    })
    expect(JSON.stringify(attempts[0]?.diagnostics)).not.toContain('spending limit reached')
  })

  test('the next Request goes straight to the healthy key', async () => {
    const cappedAuthorization = await chatThatParksTheCappedKey()
    upstream.reset()
    // The capped key is parked exhausted with a future recheck, so only the
    // healthy key can answer — and whatever is asked succeeds.
    upstream.respondWith(() => completion())

    const response = await chat()

    expect(response.status).toBe(200)
    expect(inferencePosts()).toHaveLength(1)
    expect(inferencePosts()[0]?.headers.authorization).not.toBe(cappedAuthorization)
  })

  test('a manual key test does not resurrect the parked key', async () => {
    // The probe answers `GET /models` with 2xx even for a spending-capped key,
    // so the verdict is `authenticated` — authentication only. It must not
    // clear the billing exhaustion, exactly as the reconciliation contract
    // promises.
    const cappedAuthorization = await chatThatParksTheCappedKey()
    const keys = await iroha.database.providers.listKeys(providerId)
    const capped = keys.find((key) => key.health === 'exhausted')!
    upstream.reset()
    upstream.respondWith(() => Response.json({ object: 'list', data: [] }, { status: 200 }))

    await iroha.fetch(`/api/v1/admin/providers/${providerId}/keys/${capped.id}/test`, {
      method: 'POST',
      csrf,
    })
    const after = (await iroha.database.providers.listKeys(providerId))
      .find((key) => key.id === capped.id)!
    expect(after.health).toBe('exhausted')
    expect(after.lastProbeVerdict).toBe('authenticated')

    upstream.reset()
    upstream.respondWith(() => completion())
    const response = await chat()

    expect(response.status).toBe(200)
    expect(inferencePosts()).toHaveLength(1)
    expect(inferencePosts()[0]?.headers.authorization).not.toBe(cappedAuthorization)
  })
})
