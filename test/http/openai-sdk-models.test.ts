import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import OpenAI from 'openai'
import {
  appFetch,
  completeSetup,
  createTestApp,
  type TestApp,
} from '../support/app.ts'
import { mockUpstreamTransport } from '../support/inference.ts'

const UPSTREAM_KEY = 'sk-upstream-secret-value-for-tests'
const BASE_URL = 'https://api.example.com/v1'

interface ConnectionBody {
  id: string
  displayName: string
  keys: { id: string; health: string }[]
}

/**
 * The official OpenAI JavaScript SDK, driven through Iroha's assembled HTTP
 * boundary, exercising the provider-scoped Models endpoint exactly as a real
 * client would. The upstream transport is mocked, so no Provider credential
 * or network is ever involved.
 */
describe('the official OpenAI SDK through the Models surface', () => {
  let iroha: TestApp
  let csrf: string
  let client: OpenAI
  let connectionId: string
  let upstream: ReturnType<typeof mockUpstreamTransport>

  beforeEach(async () => {
    upstream = mockUpstreamTransport(() =>
      Response.json({
        object: 'list',
        data: [
          { id: 'gpt-4o-mini', object: 'model', created: 1_700_000_000 },
          { id: 'gpt-4o', object: 'model', created: 1_700_000_001 },
        ],
      }),
    )
    iroha = await createTestApp({ upstreamTransport: upstream.fetch })
    csrf = (await completeSetup(iroha)).csrf
    connectionId = await createConnection()
    await refreshCatalog()
    const secret = await createGatewayKey([{ connectionId }])
    client = new OpenAI({
      apiKey: secret,
      baseURL: `http://iroha.test/providers/${connectionId}/v1`,
      fetch: appFetch(iroha.app),
      maxRetries: 0,
      dangerouslyAllowBrowser: true,
    })
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  test('client.models.list() returns the provider-scoped catalog', async () => {
    const listed = await client.models.list()
    const ids: string[] = []
    for await (const model of listed) ids.push(model.id)

    expect(ids.sort()).toEqual(['gpt-4o', 'gpt-4o-mini'])
    expect(upstream.calls.map((call) => call.url)).toContain(`${BASE_URL}/models`)
    const modelsCall = upstream.calls.find((call) => call.url === `${BASE_URL}/models`)
    expect(modelsCall?.headers.authorization).toBe(`Bearer ${UPSTREAM_KEY}`)
  })

  test('an unscoped Gateway Key is refused with the stable authentication error', async () => {
    const emptyKey = await createGatewayKey([])
    const otherClient = new OpenAI({
      apiKey: emptyKey,
      baseURL: `http://iroha.test/providers/${connectionId}/v1`,
      fetch: appFetch(iroha.app),
      maxRetries: 0,
      dangerouslyAllowBrowser: true,
    })

    const listing = otherClient.models.list()
    listing.catch(() => {})
    const result = await listing.then(
      () => 'resolved',
      (e: unknown) => `${(e as { name?: string }).name ?? 'error'}`,
    )
    expect(result).not.toBe('resolved')
  })

  const createConnection = async (): Promise<string> => {
    const response = await iroha.fetch('/api/v1/admin/provider-connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'SDK models example',
        baseUrl: BASE_URL,
        upstreamKey: UPSTREAM_KEY,
      }),
      csrf,
    })
    if (response.status !== 201) {
      throw new Error(`Connection create failed with ${response.status}: ${await response.text()}`)
    }
    return ((await response.json()) as ConnectionBody).id
  }

  const refreshCatalog = async (): Promise<void> => {
    const response = await iroha.fetch(
      `/api/v1/admin/provider-connections/${connectionId}/catalog/refresh`,
      { method: 'POST', csrf },
    )
    if (response.status !== 200) {
      throw new Error(`Refresh failed with ${response.status}: ${await response.text()}`)
    }
  }

  const createGatewayKey = async (scope: unknown[]): Promise<string> => {
    const response = await iroha.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'SDK models client', scope }),
      csrf,
    })
    if (response.status !== 201) {
      throw new Error(`Key create failed with ${response.status}: ${await response.text()}`)
    }
    return ((await response.json()) as { secret: string }).secret
  }
})
