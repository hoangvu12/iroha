import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { hashSecret, secretsMatch } from '../../src/identity/index.ts'
import {
  completeSetup,
  createTestApp,
  errorCode,
  type TestApp,
} from '../support/app.ts'

const UPSTREAM_KEY = 'sk-upstream-secret-value-for-tests'
const BASE = '/api/v1/admin/gateway-keys'
const DIRECTORY = '/api/v1/directory/providers'

interface GatewayKeyBody {
  id: string
  name: string
  scope: { providerId: string; models: string[] | null }[]
  createdAt: string
  lastUsedAt: string | null
  revoked: boolean
}

interface CreatedKeyBody extends GatewayKeyBody {
  secret: string
}

interface ConnectionBody {
  id: string
  displayName: string
}

describe('Gateway Key administration', () => {
  let iroha: TestApp
  let csrf: string

  beforeEach(async () => {
    iroha = await createTestApp()
    csrf = (await completeSetup(iroha)).csrf
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  const createConnection = async (displayName: string): Promise<ConnectionBody> => {
    const response = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName,
        baseUrl: 'https://api.example.com/v1',
        upstreamKey: UPSTREAM_KEY,
      }),
      csrf,
    })
    if (response.status !== 201) {
      throw new Error(`Connection create failed with ${response.status}: ${await response.text()}`)
    }
    return (await response.json()) as ConnectionBody
  }

  const createKeyRequest = (fields: Record<string, unknown> = {}) =>
    iroha.fetch(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'App credential', scope: [], ...fields }),
      csrf,
    })

  const createKey = async (fields: Record<string, unknown> = {}): Promise<CreatedKeyBody> => {
    const response = await createKeyRequest(fields)
    if (response.status !== 201) {
      throw new Error(`Key create failed with ${response.status}: ${await response.text()}`)
    }
    return (await response.json()) as CreatedKeyBody
  }

  const discover = (token: string) =>
    iroha.fetch(DIRECTORY, { headers: { authorization: `Bearer ${token}` } })

  const body = (data: Record<string, unknown>) => JSON.stringify(data)

  describe('protection', () => {
    test('refuses an unsigned-out browser', async () => {
      const unclaimed = await createTestApp()
      try {
        const response = await unclaimed.fetch(BASE)
        expect(response.status).toBe(401)
        expect(await errorCode(response)).toBe('authentication_required')
      } finally {
        await unclaimed.dispose()
      }
    })

    test('refuses a mutation without the session token', async () => {
      const response = await iroha.fetch(BASE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body({ name: 'App credential', scope: [] }),
      })

      expect(response.status).toBe(403)
      expect(await errorCode(response)).toBe('csrf_token_invalid')
    })

    test('refuses cross-origin management requests', async () => {
      const response = await iroha.fetch(BASE, { headers: { origin: 'https://evil.example' } })

      expect(response.status).toBe(403)
      expect(await errorCode(response)).toBe('cross_origin_denied')
    })
  })

  describe('creation and the one-time secret', () => {
    test('creates a named key with a public identity and a usable secret', async () => {
      const created = await createKey({ name: 'Production app' })

      expect(created.id).toMatch(/^gk_/)
      expect(created.name).toBe('Production app')
      expect(created.secret).toMatch(/^gk_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/)
      expect(created.secret.startsWith(`${created.id}.`)).toBe(true)
      expect(created.scope).toEqual([])
      expect(created.createdAt).toBe('2026-01-01T00:00:00.000Z')
      expect(created.lastUsedAt).toBeNull()
      expect(created.revoked).toBe(false)
    })

    test('stores only the hash of the secret, never the plaintext', async () => {
      const created = await createKey()

      const stored = await iroha.database.gatewayKeys.get(created.id)
      expect(stored).not.toBeNull()
      expect(stored!.secretHash).not.toBe(created.secret)
      expect(stored!.secretHash).not.toContain(created.secret.split('.')[1]!)
      expect(stored!.secretHash).not.toContain(created.id)

      expect(secretsMatch(stored!.secretHash, hashSecret(created.secret.split('.')[1]!))).toBe(true)
    })

    test('reveals the secret exactly once: every later response omits it', async () => {
      const created = await createKey()

      const listed = await (await iroha.fetch(BASE)).text()
      expect(listed).not.toContain(created.secret)

      const inspected = await (await iroha.fetch(`${BASE}/${created.id}`)).text()
      expect(inspected).not.toContain(created.secret)

      const body = (await (
        await iroha.fetch(`${BASE}/${created.id}`)
      ).json()) as GatewayKeyBody
      expect('secret' in body).toBe(false)
    })

    test('reports every setup problem together, naming the rules not the values', async () => {
      const response = await createKeyRequest({ name: '' })
      expect(response.status).toBe(400)

      const failure = await errorOf(response)
      expect(failure.code).toBe('validation_failed')
      expect(failure.problems.map((problem) => problem.field)).toEqual(['name'])
    })

    test('refuses a scope entry that names an unknown connection', async () => {
      const response = await createKeyRequest({ scope: [{ providerId: 'pc_absent' }] })

      expect(response.status).toBe(400)

      const failure = await errorOf(response)
      expect(failure.code).toBe('validation_failed')
      expect(failure.problems.map((problem) => problem.field)).toEqual(['scope'])
    })

    test('refuses a scope entry that names an archived connection', async () => {
      const connection = await createConnection('To be archived')
      await iroha.fetch(`/api/v1/admin/providers/${connection.id}/archive`, {
        method: 'POST',
        csrf,
      })

      const response = await createKeyRequest({ scope: [{ providerId: connection.id }] })

      expect(response.status).toBe(400)
      expect((await errorOf(response)).problems.map((problem) => problem.field)).toEqual(['scope'])
    })

    test('refuses malformed allowed models', async () => {
      const connection = await createConnection('Model rules')

      const notAList = await createKeyRequest({
        scope: [{ providerId: connection.id, models: 'gpt-4o' }],
      })
      expect(notAList.status).toBe(400)

      const tooLong = await createKeyRequest({
        scope: [{ providerId: connection.id, models: ['x'.repeat(129)] }],
      })
      expect(tooLong.status).toBe(400)

      for (const response of [notAList, tooLong]) {
        const failure = await errorOf(response)
        expect(failure.code).toBe('validation_failed')
        expect(failure.problems.map((problem) => problem.field)).toEqual(['scope'])
      }
    })

    test('deduplicates repeated connections and model IDs', async () => {
      const connection = await createConnection('Dedupe me')

      const created = await createKey({
        scope: [
          { providerId: connection.id, models: ['gpt-4o', 'gpt-4o', 'gpt-4o-mini'] },
          { providerId: connection.id },
        ],
      })

      expect(created.scope).toEqual([{ providerId: connection.id, models: ['gpt-4o', 'gpt-4o-mini'] }])
    })

    test('accepts a key with no scope, which can discover nothing', async () => {
      const created = await createKey()

      const response = await discover(created.secret)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ providers: [] })
    })
  })

  describe('metadata and last use', () => {
    test('records the first successful use and slides it forward', async () => {
      const created = await createKey()

      iroha.clock.advance(120)
      expect((await discover(created.secret)).status).toBe(200)
      const firstUse = '2026-01-01T00:02:00.000Z'
      expect(((await inspected(created.id)).lastUsedAt)).toBe(firstUse)

      iroha.clock.advance(60)
      await discover(created.secret)

      const updated = await inspected(created.id)
      expect(updated.lastUsedAt).toBe('2026-01-01T00:03:00.000Z')
      expect(updated.createdAt).toBe('2026-01-01T00:00:00.000Z')
    })

    test('failed attempts never count as a use', async () => {
      const created = await createKey()
      iroha.clock.advance(300)

      const { id } = created
      for (const attempt of [`${id}.wrongsecret`, 'gk_absent.also-wrong', 'not-a-token']) {
        expect((await discover(attempt)).status).toBe(401)
      }

      expect((await inspected(created.id)).lastUsedAt).toBeNull()
    })

    test('lists every key, most recently created first', async () => {
      const first = await createKey({ name: 'First' })
      iroha.clock.advance(60)
      await createKey({ name: 'Second' })

      const listed = (await (await iroha.fetch(BASE)).json()) as { keys: GatewayKeyBody[] }
      expect(listed.keys.map((key) => key.name)).toEqual(['Second', 'First'])
      expect(listed.keys[0]?.id).not.toBe(first.id)
    })
  })

  describe('revocation', () => {
    test('revokes a key permanently while keeping it listed', async () => {
      const created = await createKey()

      const response = await iroha.fetch(`${BASE}/${created.id}/revoke`, { method: 'POST', csrf })
      expect(response.status).toBe(200)

      const revoked = (await response.json()) as GatewayKeyBody
      expect(revoked.revoked).toBe(true)

      const listed = (await (await iroha.fetch(BASE)).json()) as { keys: GatewayKeyBody[] }
      expect(listed.keys.some((key) => key.id === created.id && key.revoked)).toBe(true)
    })

    test('a revoked key stops authenticating with the stable sanitized error', async () => {
      const created = await createKey()
      await iroha.fetch(`${BASE}/${created.id}/revoke`, { method: 'POST', csrf })

      const response = await discover(created.secret)

      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({
        error: { code: 'gateway_key_invalid', message: 'This Gateway Key is not valid.' },
      })
    })

    test('revoking twice changes nothing the second time', async () => {
      const created = await createKey()
      await iroha.fetch(`${BASE}/${created.id}/revoke`, { method: 'POST', csrf })

      const second = await iroha.fetch(`${BASE}/${created.id}/revoke`, { method: 'POST', csrf })

      expect(second.status).toBe(200)
      expect(((await second.json()) as GatewayKeyBody).revoked).toBe(true)
      const stored = await iroha.database.gatewayKeys.get(created.id)
      expect(stored?.revokedAt).toEqual(new Date('2026-01-01T00:00:00.000Z'))
    })

    test('reports an unknown key', async () => {
      const response = await iroha.fetch(`${BASE}/gk_absent/revoke`, { method: 'POST', csrf })

      expect(response.status).toBe(404)
      expect(await errorCode(response)).toBe('gateway_key_not_found')
    })
  })

  describe('directory scope filtering', () => {
    test('returns only the connections and models the key may use', async () => {
      const alpha = await createConnection('Alpha')
      const beta = await createConnection('Beta')
      await createConnection('Gamma')

      const created = await createKey({
        scope: [
          { providerId: alpha.id, models: ['gpt-4o', 'gpt-4o-mini'] },
          { providerId: beta.id },
        ],
      })

      const response = await discover(created.secret)
      expect(response.status).toBe(200)

      const { providers } = (await response.json()) as {
        providers: {
          id: string
          displayName: string
          url: string
          models: string[]
          capabilities: Record<string, never>
        }[]
      }

      expect(providers.map((provider) => provider.id).sort()).toEqual(
        [alpha.id, beta.id].sort(),
      )
      expect(providers.find((provider) => provider.id === alpha.id)).toMatchObject({
        displayName: 'Alpha',
        url: `/providers/${alpha.id}/v1`,
        models: ['gpt-4o', 'gpt-4o-mini'],
        capabilities: {},
      })
      expect(providers.find((provider) => provider.id === beta.id)).toMatchObject({
        models: [],
      })
    })

    test('drops connections the scope names once they are archived or purged', async () => {
      const alpha = await createConnection('Alpha')
      const beta = await createConnection('Beta')

      const created = await createKey({
        scope: [{ providerId: alpha.id }, { providerId: beta.id }],
      })

      await iroha.fetch(`/api/v1/admin/providers/${beta.id}/archive`, {
        method: 'POST',
        csrf,
      })

      let providers = await discoveredProviders(created.secret)
      expect(providers.map((provider) => provider.id)).toEqual([alpha.id])

      await iroha.fetch(`/api/v1/admin/providers/${alpha.id}/archive`, {
        method: 'POST',
        csrf,
      })
      await iroha.fetch(`/api/v1/admin/providers/${alpha.id}/purge`, {
        method: 'POST',
        csrf,
      })

      providers = await discoveredProviders(created.secret)
      expect(providers).toEqual([])
    })
  })

  describe('directory disclosure boundaries', () => {
    test('returns identity, name, scoped URL, models, and capabilities only', async () => {
      const connection = await createConnection('Disclosed name')
      const created = await createKey({ scope: [{ providerId: connection.id }] })

      const response = await discover(created.secret)
      expect(response.status).toBe(200)

      const body = (await response.json()) as {
        providers: { [key: string]: unknown }[]
      }
      expect(body.providers).toHaveLength(1)
      expect(Object.keys(body.providers[0]!).sort()).toEqual([
        'capabilities',
        'displayName',
        'id',
        'models',
        'url',
      ])

      const text = await (await discover(created.secret)).text()
      expect(text).not.toContain('https://api.example.com')
      expect(text).not.toContain(UPSTREAM_KEY)
      expect(text).not.toContain('enabled')
      expect(text).not.toContain('archived')
      expect(text).not.toContain('allowInsecureHttp')
      expect(text).not.toContain('health')
      expect(text).not.toContain('balance')
    })
  })

  describe('directory authentication', () => {
    test('answers the same stable error for every failure', async () => {
      const created = await createKey()
      const { id } = created

      const responses = [
        await iroha.fetch(DIRECTORY),
        await iroha.fetch(DIRECTORY, { headers: { authorization: `Bearer ${id}` } }),
        await iroha.fetch(DIRECTORY, { headers: { authorization: `Bearer ${id}.` } }),
        await iroha.fetch(DIRECTORY, { headers: { authorization: `Bearer ${id}.wrong` } }),
        await iroha.fetch(DIRECTORY, {
          headers: { authorization: `Basic ${Buffer.from('owner:password').toString('base64')}` },
        }),
      ]

      for (const response of responses) {
        expect(response.status).toBe(401)
        expect(await response.json()).toEqual({
          error: { code: 'gateway_key_invalid', message: 'This Gateway Key is not valid.' },
        })
      }
    })

    test('case-insensitive Bearer scheme is accepted', async () => {
      const created = await createKey()

      const response = await iroha.fetch(DIRECTORY, {
        headers: { authorization: `bearer ${created.secret}` },
      })

      expect(response.status).toBe(200)
    })
  })

  describe('audit', () => {
    test('creation and revocation are audited without the secret', async () => {
      const created = await createKey({ name: 'Audited key' })
      await iroha.fetch(`${BASE}/${created.id}/revoke`, { method: 'POST', csrf })

      const events = await iroha.database.audit.list()
      const actions = events.map((event) => event.action)
      expect(actions).toContain('gateway_key.created')
      expect(actions).toContain('gateway_key.revoked')

      const createdEvent = events.find((event) => event.action === 'gateway_key.created')
      expect(createdEvent?.detail).toEqual({ gatewayKeyId: created.id, name: 'Audited key' })

      for (const event of events) {
        expect(JSON.stringify(event.detail ?? null)).not.toContain(created.secret)
      }
    })
  })

  describe('generated API documentation', () => {
    test('represents the Gateway Key and directory surface', async () => {
      const document = (await (await iroha.fetch('/docs/json')).json()) as {
        paths?: Record<string, unknown>
      }

      const paths = Object.keys(document.paths ?? {})

      expect(paths).toEqual(
        expect.arrayContaining([
          '/api/v1/admin/gateway-keys',
          '/api/v1/admin/gateway-keys/{id}',
          '/api/v1/admin/gateway-keys/{id}/revoke',
          '/api/v1/directory/providers',
        ]),
      )
    })
  })

  async function inspected(id: string): Promise<GatewayKeyBody> {
    const response = await iroha.fetch(`${BASE}/${id}`)
    if (response.status !== 200) {
      throw new Error(`Inspect failed with ${response.status}: ${await response.text()}`)
    }
    return (await response.json()) as GatewayKeyBody
  }

  async function discoveredProviders(
    token: string,
  ): Promise<{ id: string; displayName: string; url: string; models: string[] }[]> {
    const response = await discover(token)
    if (response.status !== 200) {
      throw new Error(`Discover failed with ${response.status}: ${await response.text()}`)
    }
    return ((await response.json()) as { providers: { id: string }[] }).providers as {
      id: string
      displayName: string
      url: string
      models: string[]
    }[]
  }
})

async function errorOf(
  response: Response,
): Promise<{ code: string; problems: { field: string; message: string }[] }> {
  const body = (await response.json()) as {
    error?: { code?: string; problems?: { field: string; message: string }[] }
  }
  return { code: body.error?.code ?? '(no error code)', problems: body.error?.problems ?? [] }
}
