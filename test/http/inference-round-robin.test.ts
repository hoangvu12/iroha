import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  completeSetup,
  createTestApp,
  fakeKeyProbe,
  type TestApp,
} from '../support/app.ts'
import { mockUpstreamTransport } from '../support/inference.ts'
import type { ProviderView } from '../../src/providers/index.ts'

const UPSTREAM_KEY = 'sk-upstream-secret-value-for-tests'
const BASE_URL = 'https://api.example.com/v1'
const MODEL = 'gpt-4o-mini'
const OTHER_MODEL = 'gpt-4o'

interface ConnectionBody {
  id: string
  keys: { id: string; health: string; accountId: string | null; baseUrl: string | null }[]
}

describe('round-robin key selection on the inference path', () => {
  let iroha: TestApp
  let csrf: string
  let upstream: ReturnType<typeof mockUpstreamTransport>
  let connection: ConnectionBody
  let secret: string
  let path: string

  beforeEach(async () => {
    upstream = mockUpstreamTransport()
    iroha = await createTestApp({ upstreamTransport: upstream.fetch })
    csrf = (await completeSetup(iroha)).csrf
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  const createConnection = async (): Promise<ConnectionBody> => {
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
      throw new Error(`Create failed with ${response.status}: ${await response.text()}`)
    }
    return (await response.json()) as ConnectionBody
  }

  const addKey = async (providerId: string, upstreamKey: string) => {
    const response = await iroha.fetch(
      `/api/v1/admin/provider-connections/${providerId}/keys`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ upstreamKey }),
        csrf,
      },
    )
    if (response.status !== 201) {
      throw new Error(`Add key failed with ${response.status}: ${await response.text()}`)
    }
    return (await response.json()) as ConnectionBody
  }

  /**
   * Adds a key directly through the ProviderRegistry so the test can attach a
   * per-Key base URL override. The admin POST does not yet accept baseUrl
   * (that field arrives with ticket 04's admin rename); the inference route
   * already honors the override.
   */
  const addKeyWithOverride = async (
    providerId: string,
    upstreamKey: string,
    baseUrl: string,
  ): Promise<ProviderView> => {
    const result = await iroha.providers.addKey(providerId, {
      upstreamKey,
      baseUrl,
    })
    if (!result.ok) throw new Error(`Add key failed with ${result.failure.code}`)
    return result.value
  }

  const configureKey = async (providerId: string, keyId: string, patch: Record<string, unknown>) => {
    const response = await iroha.fetch(
      `/api/v1/admin/provider-connections/${providerId}/keys/${keyId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
        csrf,
      },
    )
    expect(response.status).toBe(200)
  }

  const chat = (model: string = MODEL, headers: Record<string, string> = {}) =>
    iroha.fetch(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
        ...headers,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Say hello' }],
      }),
    })

  const connect = async () => {
    connection = await createConnection()
    path = `/providers/${connection.id}/v1/chat/completions`
    const created = await iroha.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'App credential', scope: [{ providerId: connection.id }] }),
      csrf,
    })
    secret = ((await created.json()) as { secret: string }).secret
  }

  test('rotates the selected key round-robin across equal requests', async () => {
    await connect()
    connection = await addKey(connection.id, 'sk-second-upstream-key-for-tests')
    connection = await addKey(connection.id, 'sk-third-upstream-key-for-tests')
    expect(connection.keys).toHaveLength(3)

    const used: string[] = []
    for (let index = 0; index < 6; index++) {
      const response = await chat()
      expect(response.status).toBe(200)
    }
    used.push(...upstream.calls.map((call) => call.headers.authorization ?? ''))

    const keys = new Set([
      `Bearer ${UPSTREAM_KEY}`,
      'Bearer sk-second-upstream-key-for-tests',
      'Bearer sk-third-upstream-key-for-tests',
    ])
    expect(new Set(used.slice(0, 3))).toEqual(keys)
    expect(used.slice(3)).toEqual(used.slice(0, 3))
  })

  test('excludes disabled, unverified, and model-ineligible keys', async () => {
    await connect()
    connection = await addKey(connection.id, 'sk-second-upstream-key-for-tests')
    connection = await addKey(connection.id, 'sk-third-upstream-key-for-tests')
    const [first, second, third] = connection.keys
    expect(first).toBeDefined()

    // Disable one, restrict another to a different model: only one key remains.
    await iroha.fetch(
      `/api/v1/admin/provider-connections/${connection.id}/keys/${first!.id}/disable`,
      { method: 'POST', csrf },
    )
    await configureKey(connection.id, second!.id, { allowedModels: [OTHER_MODEL] })

    const used: string[] = []
    for (let index = 0; index < 4; index++) {
      const response = await chat()
      expect(response.status).toBe(200)
      used.push(upstream.calls.at(-1)?.headers.authorization ?? '')
    }

    // The disabled and model-ineligible keys never serve; the survivor answers
    // every request and the rotation keeps selecting it.
    expect(new Set(used)).toHaveLength(1)
  })

  test('reports upstream_credentials_unavailable when every key is ineligible', async () => {
    await connect()
    const keyId = connection.keys[0]!.id
    await iroha.fetch(
      `/api/v1/admin/provider-connections/${connection.id}/keys/${keyId}/disable`,
      { method: 'POST', csrf },
    )

    const response = await chat()

    expect(response.status).toBe(503)
    const body = (await response.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('upstream_credentials_unavailable')
    expect(upstream.calls).toHaveLength(0)
  })

  test('model ineligibility alone produces the same unavailable answer', async () => {
    await connect()
    const keyId = connection.keys[0]!.id
    await configureKey(connection.id, keyId, { deniedModels: [MODEL] })

    const response = await chat(MODEL)

    expect(response.status).toBe(503)
    expect(upstream.calls).toHaveLength(0)
  })

  test('selection writes nothing durable: keys and audit are untouched by inference', async () => {
    await connect()
    connection = await addKey(connection.id, 'sk-second-upstream-key-for-tests')
    connection = await addKey(connection.id, 'sk-third-upstream-key-for-tests')

    const snapshot = async () => ({
      keys: await iroha.database.providers.listKeys(connection.id),
      accounts: await iroha.database.providers.listAccounts(connection.id),
      auditCount: (await iroha.database.audit.list()).length,
    })

    const before = await snapshot()
    for (let index = 0; index < 5; index++) {
      const response = await chat()
      expect(response.status).toBe(200)
    }
    const after = await snapshot()

    // Rotation picked keys without persisting a cursor, a health change, or an
    // audit event; the durable rows are byte-for-byte the ones that were there.
    expect(after.keys).toEqual(before.keys)
    expect(after.accounts).toEqual(before.accounts)
    expect(after.auditCount).toBe(before.auditCount)
  })

  test('a key restricted to one model serves only that model', async () => {
    await connect()
    await configureKey(connection.id, connection.keys[0]!.id, { allowedModels: [OTHER_MODEL] })

    const refused = await chat(MODEL)
    expect(refused.status).toBe(503)

    const accepted = await chat(OTHER_MODEL)
    expect(accepted.status).toBe(200)
    expect(upstream.calls.at(-1)?.headers.authorization).toBe(`Bearer ${UPSTREAM_KEY}`)
  })

  test('round-robin uses each key\'s own base URL when it wins', async () => {
    const overrideUrl = 'https://api.override.example.com/v1'
    const overrideKey = 'sk-override-upstream-key-for-tests'

    await connect()
    const view = await addKeyWithOverride(connection.id, overrideKey, overrideUrl)
    expect(view.keys).toHaveLength(2)

    for (let index = 0; index < 4; index += 1) {
      const response = await chat()
      expect(response.status).toBe(200)
    }

    const defaultCalls = upstream.calls.filter((call) => call.url.startsWith(`${BASE_URL}/`))
    const overrideCalls = upstream.calls.filter((call) => call.url.startsWith(`${overrideUrl}/`))
    expect(defaultCalls).toHaveLength(2)
    expect(overrideCalls).toHaveLength(2)
    expect(defaultCalls.every((call) => call.headers.authorization === `Bearer ${UPSTREAM_KEY}`)).toBe(true)
    expect(overrideCalls.every((call) => call.headers.authorization === `Bearer ${overrideKey}`)).toBe(true)
  })

  test('clearing a key\'s base URL override makes it inherit the Provider default', async () => {
    const overrideUrl = 'https://api.override.example.com/v1'
    const overrideKey = 'sk-override-upstream-key-for-tests'

    await connect()
    const view = await addKeyWithOverride(connection.id, overrideKey, overrideUrl)
    const overrideKeyRow = view.keys.find((candidate) => candidate.baseUrl === overrideUrl)
    expect(overrideKeyRow).toBeDefined()

    const cleared = await iroha.providers.updateKeySettings(connection.id, overrideKeyRow!.id, {
      baseUrl: null,
    })
    expect(cleared.ok).toBe(true)

    for (let index = 0; index < 4; index += 1) {
      const response = await chat()
      expect(response.status).toBe(200)
    }

    expect(upstream.calls.every((call) => call.url.startsWith(`${BASE_URL}/`))).toBe(true)
  })
})
