import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import OpenAI from 'openai'
import {
  completeSetup,
  createTestApp,
  type TestApp,
} from '../support/app.ts'
import { appFetch } from '../support/app.ts'
import { mockUpstreamTransport } from '../support/inference.ts'

const UPSTREAM_KEY = 'sk-upstream-secret-value-for-tests'
const BASE_URL = 'https://api.example.com/v1'
const MODEL = 'gpt-4o-mini'

interface ConnectionBody {
  id: string
  displayName: string
  keys: { id: string; health: string }[]
}

/**
 * The official OpenAI JavaScript SDK, driven through Iroha's assembled HTTP
 * boundary exactly as a real client would. The upstream transport is mocked,
 * so no Provider credential or network is ever involved.
 */
describe('the official OpenAI SDK through the Chat Completions surface', () => {
  let iroha: TestApp
  let csrf: string
  let client: OpenAI
  let providerId: string
  let upstream: ReturnType<typeof mockUpstreamTransport>

  beforeEach(async () => {
    upstream = mockUpstreamTransport()
    iroha = await createTestApp({ upstreamTransport: upstream.fetch })
    csrf = (await completeSetup(iroha)).csrf
    providerId = await createConnection()
    const secret = await createGatewayKey([{ providerId }])
    client = new OpenAI({
      apiKey: secret,
      baseURL: `http://iroha.test/providers/${providerId}/v1`,
      fetch: appFetch(iroha.app),
      maxRetries: 0,
      // UI tests register a DOM in the same process, which makes the SDK's
      // browser guard fire; this is test-only and never carries real secrets.
      dangerouslyAllowBrowser: true,
    })
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  test('non-streaming chat completions reach the mocked upstream unchanged', async () => {
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: 'Say hello' }],
      temperature: 0.7,
    })

    expect(completion.model).toBe(MODEL)
    expect(completion.choices[0]?.message.content).toBe('Mock upstream reply')

    expect(upstream.calls).toHaveLength(1)
    const forwarded = upstream.calls[0]!
    expect(forwarded.url).toBe(`${BASE_URL}/chat/completions`)
    expect(forwarded.headers.authorization).toBe(`Bearer ${UPSTREAM_KEY}`)
    const body = JSON.parse(forwarded.body ?? '{}') as { model: string; temperature: number }
    expect(body.model).toBe(MODEL)
    expect(body.temperature).toBe(0.7)
  })

  test('unknown request fields survive the SDK round trip', async () => {
    await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: 'hello' }],
      // An SDK extension field that Iroha itself knows nothing about.
      user: 'app-user-123',
      seed: 42,
    } as never)

    const forwarded = upstream.calls[0]!
    const body = JSON.parse(forwarded.body ?? '{}') as { seed: number; user: string }
    expect(body.seed).toBe(42)
    expect(body.user).toBe('app-user-123')
  })

  test('an upstream failure surfaces as an OpenAI-shaped error', async () => {
    upstream.respondWith(() => new Response('bad upstream', { status: 503 }))

    const create = client.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: 'hello' }],
    })
    create.catch(() => {})
    const result = await create.then(
      () => 'resolved',
      (e: unknown) => `${(e as { name?: string }).name ?? 'error'}`,
    )
    expect(result).not.toBe('resolved')
    expect(upstream.calls.length).toBeGreaterThan(0)
  })

  test('an invalid Gateway Key is refused as an authentication error', async () => {
    const bad = new OpenAI({
      apiKey: 'gk_not-a-real-key',
      baseURL: `http://iroha.test/providers/${providerId}/v1`,
      fetch: appFetch(iroha.app),
      dangerouslyAllowBrowser: true,
    })

    const create = bad.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: 'hello' }],
    })
    create.catch(() => {})
    const result = await create.then(
      () => 'resolved',
      (e: unknown) => `${(e as { name?: string }).name ?? 'error'}`,
    )
    expect(result).not.toBe('resolved')
    expect(upstream.calls).toHaveLength(0)
  })

  const createConnection = async (): Promise<string> => {
    const response = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'SDK example',
        baseUrl: BASE_URL,
        upstreamKey: UPSTREAM_KEY,
      }),
      csrf,
    })
    if (response.status !== 201) {
      throw new Error(`Connection create failed with ${response.status}: ${await response.text()}`)
    }
    const connection = (await response.json()) as ConnectionBody
    return connection.id
  }

  const createGatewayKey = async (scope: unknown[]): Promise<string> => {
    const response = await iroha.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'SDK client', scope }),
      csrf,
    })
    if (response.status !== 201) {
      throw new Error(`Key create failed with ${response.status}: ${await response.text()}`)
    }
    const key = (await response.json()) as { secret: string }
    return key.secret
  }
})
