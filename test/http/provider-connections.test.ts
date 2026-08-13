import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createSecretCipher } from '../../src/crypto/index.ts'
import {
  completeSetup,
  createTestApp,
  errorCode,
  fakeKeyProbe,
  TEST_MASTER_KEY,
  type FakeKeyProbe,
  type TestApp,
} from '../support/app.ts'

const UPSTREAM_KEY = 'sk-upstream-secret-value-for-tests'
const BASE_URL = 'https://api.example.com/v1'
const BASE = '/api/v1/admin/provider-connections'

interface ConnectionBody {
  id: string
  displayName: string
  baseUrl: string
  allowInsecureHttp: boolean
  enabled: boolean
  archived: boolean
  createdAt: string
  updatedAt: string
  keys: {
    id: string
    health: 'unverified' | 'active' | 'disabled'
    baseUrl: string | null
    effectiveBaseUrl: string
    lastProbe: { at: string; verdict: string; reason: string | null } | null
    createdAt: string
    updatedAt: string
  }[]
}

describe('Provider Connection administration', () => {
  let iroha: TestApp
  let probe: FakeKeyProbe
  let csrf: string

  beforeEach(async () => {
    probe = fakeKeyProbe()
    iroha = await createTestApp({ upstreamKeyProbe: probe })
    csrf = (await completeSetup(iroha)).csrf
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  const createRequest = (fields: Record<string, unknown> = {}) =>
    iroha.fetch(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Example', baseUrl: BASE_URL, upstreamKey: UPSTREAM_KEY, ...fields }),
      csrf,
    })

  const createConnection = async (fields: Record<string, unknown> = {}): Promise<ConnectionBody> => {
    const response = await createRequest(fields)
    if (response.status !== 201) {
      throw new Error(`Create failed with ${response.status}: ${await response.text()}`)
    }
    return (await response.json()) as ConnectionBody
  }

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
        body: body({ displayName: 'Example', baseUrl: BASE_URL, upstreamKey: UPSTREAM_KEY }),
      })

      expect(response.status).toBe(403)
      expect(await errorCode(response)).toBe('csrf_token_invalid')
    })

    test('refuses cross-origin management requests', async () => {
      const response = await iroha.fetch(BASE, { headers: { origin: 'https://evil.example' } })

      expect(response.status).toBe(403)
      expect(await errorCode(response)).toBe('cross_origin_denied')
    })

    test('lists and inspects without a CSRF token, but never without a session', async () => {
      expect((await iroha.fetch(BASE)).status).toBe(200)
      expect((await iroha.fetch(`${BASE}/pc_absent`)).status).toBe(404)
    })
  })

  describe('creation', () => {
    test('creates a connection with an immutable ID and one encrypted key', async () => {
      const created = await createConnection()

      expect(created.id).toMatch(/^pc_/)
      expect(created.displayName).toBe('Example')
      expect(created.baseUrl).toBe(BASE_URL)
      expect(created.allowInsecureHttp).toBe(false)
      expect(created.enabled).toBe(true)
      expect(created.archived).toBe(false)
      expect(created.keys).toHaveLength(1)

      const [key] = created.keys
      expect(key?.id).toMatch(/^uk_/)
      expect(key?.health).toBe('active')
      expect(key?.lastProbe).toMatchObject({ verdict: 'usable', reason: null })
    })

    test('sends the submitted key to the provider seam, not to storage', async () => {
      await createConnection()

      expect(probe.calls).toEqual([{ baseUrl: BASE_URL, upstreamKey: UPSTREAM_KEY }])
    })

    test('keeps a usable probe result and activates the key on creation', async () => {
      probe.respondWith({ verdict: 'usable', reason: null })

      const created = await createConnection()

      expect(created.keys[0]?.health).toBe('active')
    })

    test('keeps the key Unverified with its reason after an inconclusive test', async () => {
      probe.respondWith({
        verdict: 'inconclusive',
        reason: 'the provider rate-limited the test (HTTP 429)',
      })

      const created = await createConnection()

      expect(created.keys[0]?.health).toBe('unverified')
      expect(created.keys[0]?.lastProbe).toMatchObject({
        verdict: 'inconclusive',
        reason: 'the provider rate-limited the test (HTTP 429)',
      })
    })

    test('keeps the key Unverified after the provider rejects it', async () => {
      probe.respondWith({ verdict: 'rejected', reason: 'the provider rejected the key (HTTP 401)' })

      const created = await createConnection()

      expect(created.keys[0]?.health).toBe('unverified')
      expect(created.keys[0]?.lastProbe?.verdict).toBe('rejected')
    })

    test('survives a probe that throws', async () => {
      const throwing = {
        calls: [],
        respondWith: () => undefined,
        async test() {
          throw new Error('deliberate probe failure')
        },
      }

      const app = await createTestApp({ upstreamKeyProbe: throwing })
      try {
        const signedIn = await completeSetup(app)
        const response = await app.fetch(BASE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: body({ displayName: 'Example', baseUrl: BASE_URL, upstreamKey: UPSTREAM_KEY }),
          csrf: signedIn.csrf,
        })

        const created = (await response.json()) as ConnectionBody
        expect(response.status).toBe(201)
        expect(created.keys[0]?.health).toBe('unverified')
        expect(created.keys[0]?.lastProbe?.reason).toBe('the key test did not complete')
      } finally {
        await app.dispose()
      }
    })

    test('encrypts the key at rest with the installation master key', async () => {
      await createConnection()

      const [stored] = await iroha.database.providers.listKeys(
        (await iroha.database.providers.listProviders())[0]!.id,
      )

      expect(stored?.encryptedKey).not.toBe(UPSTREAM_KEY)
      expect(stored?.encryptedKey).not.toContain(UPSTREAM_KEY)

      const cipher = createSecretCipher(TEST_MASTER_KEY)
      expect(await cipher.decrypt(stored!.encryptedKey)).toBe(UPSTREAM_KEY)
    })

    test('refuses an insecure base URL without an explicit exception', async () => {
      const response = await createRequest({ baseUrl: 'http://localhost:8000/v1' })

      expect(response.status).toBe(400)

      const failure = await errorOf(response)
      expect(failure.code).toBe('validation_failed')
      expect(failure.problems.map((problem) => problem.field)).toEqual(['baseUrl'])
    })

    test('accepts an insecure base URL once explicitly allowed', async () => {
      probe.respondWith({ verdict: 'usable', reason: null })

      const created = await createConnection({
        baseUrl: 'http://localhost:8000/v1',
        allowInsecureHttp: true,
      })

      expect(created.allowInsecureHttp).toBe(true)
      expect(created.baseUrl).toBe('http://localhost:8000/v1')
    })

    test('reports every setup problem together, naming the rules not the values', async () => {
      const response = await iroha.fetch(BASE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body({ displayName: '', baseUrl: 'not a url', upstreamKey: '' }),
        csrf,
      })

      expect(response.status).toBe(400)

      const problems = await problemsOf(response)
      expect(problems.map((problem) => problem.field).sort()).toEqual([
        'baseUrl',
        'displayName',
        'upstreamKey',
      ])
      expect(problems.map((problem) => problem.message).join(' ')).not.toContain(UPSTREAM_KEY)
    })

    test('refuses a base URL that embeds credentials', async () => {
      const response = await createRequest({ baseUrl: 'https://user:pass@api.example.com/v1' })

      expect(response.status).toBe(400)

      const failure = await errorOf(response)
      expect(failure.code).toBe('validation_failed')
      expect(failure.problems.map((problem) => problem.field)).toEqual(['baseUrl'])
    })

    test('refuses an over-long key', async () => {
      const response = await createRequest({ upstreamKey: 'k'.repeat(2049) })

      expect(response.status).toBe(400)

      const failure = await errorOf(response)
      expect(failure.code).toBe('validation_failed')
      expect(failure.problems.map((problem) => problem.field)).toEqual(['upstreamKey'])
    })

    test('refuses an unreadable request body rather than echoing it', async () => {
      const response = await iroha.fetch(BASE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
        csrf,
      })

      expect(response.status).toBe(400)

      const text = await response.text()
      expect(text).toContain('invalid_request')
      expect(text).not.toContain('not json')
    })
  })

  describe('inspection and listing', () => {
    test('lists every connection, most recently created first', async () => {
      const first = await createConnection({ displayName: 'First' })
      iroha.clock.advance(60)
      const second = await createConnection({ displayName: 'Second' })

      const listed = (await (await iroha.fetch(BASE)).json()) as { connections: ConnectionBody[] }

      expect(listed.connections.map((connection) => connection.id)).toEqual([second.id, first.id])
    })

    test('inspects one connection by its immutable ID', async () => {
      const created = await createConnection({ displayName: 'Named' })

      const response = await iroha.fetch(`${BASE}/${created.id}`)

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(created)
    })

    test('reports an unknown connection', async () => {
      const response = await iroha.fetch(`${BASE}/pc_absent`)

      expect(response.status).toBe(404)
      expect(await errorCode(response)).toBe('connection_not_found')
    })
  })

  describe('editing', () => {
    test('edits the display name and base URL without touching the ID', async () => {
      const created = await createConnection()
      iroha.clock.advance(30)

      const response = await iroha.fetch(`${BASE}/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: body({ displayName: 'Renamed', baseUrl: 'https://other.example.com/v1' }),
        csrf,
      })

      expect(response.status).toBe(200)

      const updated = (await response.json()) as ConnectionBody
      expect(updated.id).toBe(created.id)
      expect(updated.displayName).toBe('Renamed')
      expect(updated.baseUrl).toBe('https://other.example.com/v1')
      // The Key inherits the Provider's default base URL, which the edit just
      // changed. The Key's identity and health are unaffected.
      expect(updated.keys[0]?.id).toBe(created.keys[0]?.id)
      expect(updated.keys[0]?.effectiveBaseUrl).toBe('https://other.example.com/v1')
    })

    test('toggles the enabled state', async () => {
      const created = await createConnection()

      await iroha.fetch(`${BASE}/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: body({ enabled: false }),
        csrf,
      })

      const stored = await iroha.database.providers.getProvider(created.id)
      expect(stored?.enabled).toBe(false)
    })

    test('refuses to move a live connection onto plain HTTP without the exception', async () => {
      const created = await createConnection()

      const response = await iroha.fetch(`${BASE}/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: body({ baseUrl: 'http://localhost:8000/v1' }),
        csrf,
      })

      expect(response.status).toBe(400)
      expect((await problemsOf(response)).map((problem) => problem.field)).toEqual(['baseUrl'])
    })

    test('refuses to withdraw the insecure exception under a plain-HTTP URL', async () => {
      const created = await createConnection({
        baseUrl: 'http://localhost:8000/v1',
        allowInsecureHttp: true,
      })

      const response = await iroha.fetch(`${BASE}/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: body({ allowInsecureHttp: false }),
        csrf,
      })

      expect(response.status).toBe(400)
      expect((await problemsOf(response)).map((problem) => problem.field)).toEqual([
        'allowInsecureHttp',
      ])
    })

    test('reports an unknown connection', async () => {
      const response = await iroha.fetch(`${BASE}/pc_absent`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: body({ displayName: 'Nope' }),
        csrf,
      })

      expect(response.status).toBe(404)
      expect(await errorCode(response)).toBe('connection_not_found')
    })

    test('audits which fields changed, not what they changed to', async () => {
      const created = await createConnection()

      await iroha.fetch(`${BASE}/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: body({ displayName: 'Renamed', baseUrl: 'https://other.example.com/v1' }),
        csrf,
      })

      const events = await iroha.database.audit.list()
      const updated = events.find((event) => event.action === 'connection.updated')

      expect(updated?.detail).toEqual({
        providerId: created.id,
        fields: ['displayName', 'baseUrl'],
      })
    })
  })

  describe('key actions', () => {
    test('manually activates an inconclusively tested key', async () => {
      probe.respondWith({ verdict: 'inconclusive', reason: 'the provider could not be reached' })
      const created = await createConnection()

      const keyId = created.keys[0]!.id
      const response = await iroha.fetch(`${BASE}/${created.id}/keys/${keyId}/activate`, {
        method: 'POST',
        csrf,
      })

      expect(response.status).toBe(200)

      const updated = (await response.json()) as ConnectionBody
      expect(updated.keys[0]?.health).toBe('active')
      expect(updated.keys[0]?.lastProbe?.reason).toBe('the provider could not be reached')
    })

    test('a usable retest activates an Unverified key', async () => {
      probe.respondWith({ verdict: 'inconclusive', reason: 'the provider could not be reached' })
      const created = await createConnection()

      probe.respondWith({ verdict: 'usable', reason: null })
      const keyId = created.keys[0]!.id
      const response = await iroha.fetch(`${BASE}/${created.id}/keys/${keyId}/test`, {
        method: 'POST',
        csrf,
      })

      const updated = (await response.json()) as ConnectionBody
      expect(response.status).toBe(200)
      expect(updated.keys[0]?.health).toBe('active')
      expect(updated.keys[0]?.lastProbe).toMatchObject({ verdict: 'usable', reason: null })
    })

    test('retesting a Disabled key records the outcome but keeps it disabled', async () => {
      const created = await createConnection()
      const keyId = created.keys[0]!.id

      await iroha.fetch(`${BASE}/${created.id}/keys/${keyId}/disable`, { method: 'POST', csrf })

      probe.respondWith({ verdict: 'usable', reason: null })
      const response = await iroha.fetch(`${BASE}/${created.id}/keys/${keyId}/test`, {
        method: 'POST',
        csrf,
      })

      const updated = (await response.json()) as ConnectionBody
      expect(updated.keys[0]?.health).toBe('disabled')
      expect(updated.keys[0]?.lastProbe?.verdict).toBe('usable')
    })

    test('disable and activate are audited without secret values', async () => {
      const created = await createConnection()
      const keyId = created.keys[0]!.id

      await iroha.fetch(`${BASE}/${created.id}/keys/${keyId}/disable`, { method: 'POST', csrf })
      await iroha.fetch(`${BASE}/${created.id}/keys/${keyId}/activate`, { method: 'POST', csrf })

      const actions = (await iroha.database.audit.list()).map((event) => event.action)
      expect(actions).toContain('key.disabled')
      expect(actions).toContain('key.activated')

      for (const event of await iroha.database.audit.list()) {
        expect(JSON.stringify(event.detail ?? null)).not.toContain(UPSTREAM_KEY)
      }
    })

    test('refuses a key that does not belong to the connection', async () => {
      const created = await createConnection()

      const response = await iroha.fetch(`${BASE}/${created.id}/keys/uk_absent/test`, {
        method: 'POST',
        csrf,
      })

      expect(response.status).toBe(404)
      expect(await errorCode(response)).toBe('key_not_found')
    })
  })

  describe('archive and purge', () => {
    test('archiving disables the connection but preserves its identity', async () => {
      const created = await createConnection()
      iroha.clock.advance(30)

      const response = await iroha.fetch(`${BASE}/${created.id}/archive`, { method: 'POST', csrf })

      expect(response.status).toBe(200)

      const archived = (await response.json()) as ConnectionBody
      expect(archived.id).toBe(created.id)
      expect(archived.archived).toBe(true)
      expect(archived.enabled).toBe(false)
      expect(archived.keys).toEqual(created.keys)
    })

    test('archiving twice changes nothing the second time', async () => {
      const created = await createConnection()

      await iroha.fetch(`${BASE}/${created.id}/archive`, { method: 'POST', csrf })
      const second = await iroha.fetch(`${BASE}/${created.id}/archive`, { method: 'POST', csrf })

      expect(second.status).toBe(200)
      expect(((await second.json()) as ConnectionBody).archived).toBe(true)
    })

    test('an archived connection refuses edits and key actions', async () => {
      const created = await createConnection()
      await iroha.fetch(`${BASE}/${created.id}/archive`, { method: 'POST', csrf })
      const keyId = created.keys[0]!.id

      for (const request of [
        { path: `${BASE}/${created.id}`, method: 'PATCH', payload: body({ displayName: 'Nope' }) },
        { path: `${BASE}/${created.id}/keys/${keyId}/test`, method: 'POST' },
        { path: `${BASE}/${created.id}/keys/${keyId}/activate`, method: 'POST' },
        { path: `${BASE}/${created.id}/keys/${keyId}/disable`, method: 'POST' },
      ]) {
        const response = await iroha.fetch(request.path, {
          method: request.method as 'PATCH' | 'POST',
          headers:
            request.method === 'PATCH' ? { 'content-type': 'application/json' } : undefined,
          ...('payload' in request ? { body: request.payload } : {}),
          csrf,
        })

        expect(response.status).toBe(409)
        expect(await errorCode(response)).toBe('connection_archived')
      }
    })

    test('refuses to purge a connection before it is archived', async () => {
      const created = await createConnection()

      const refused = await iroha.fetch(`${BASE}/${created.id}/purge`, { method: 'POST', csrf })

      expect(refused.status).toBe(409)
      expect(await errorCode(refused)).toBe('not_archived')
      expect(await iroha.database.providers.getProvider(created.id)).not.toBeNull()
    })

    test('purge removes an archived connection and its keys permanently', async () => {
      const created = await createConnection()
      await iroha.fetch(`${BASE}/${created.id}/archive`, { method: 'POST', csrf })

      const response = await iroha.fetch(`${BASE}/${created.id}/purge`, { method: 'POST', csrf })

      expect(response.status).toBe(204)
      expect(await iroha.database.providers.getProvider(created.id)).toBeNull()
      expect(await iroha.database.providers.listKeys(created.id)).toEqual([])
      expect((await iroha.fetch(`${BASE}/${created.id}`)).status).toBe(404)
    })

    test('purging an absent connection reports it', async () => {
      const response = await iroha.fetch(`${BASE}/pc_absent/purge`, { method: 'POST', csrf })

      expect(response.status).toBe(404)
      expect(await errorCode(response)).toBe('connection_not_found')
    })
  })

  describe('duplication', () => {
    test('duplicates under a new identity without touching the original', async () => {
      const created = await createConnection({ displayName: 'Original' })

      const response = await iroha.fetch(`${BASE}/${created.id}/duplicate`, {
        method: 'POST',
        csrf,
      })

      expect(response.status).toBe(201)

      const copy = (await response.json()) as ConnectionBody
      expect(copy.id).not.toBe(created.id)
      expect(copy.id).toMatch(/^pc_/)
      expect(copy.displayName).toBe('Original (copy)')
      expect(copy.baseUrl).toBe(created.baseUrl)
      expect(copy.archived).toBe(false)
      expect(copy.enabled).toBe(true)
      expect(copy.keys[0]?.id).not.toBe(created.keys[0]?.id)
      expect(copy.keys[0]?.health).toBe('active')

      const original = (await (await iroha.fetch(`${BASE}/${created.id}`)).json()) as ConnectionBody
      expect(original.displayName).toBe('Original')
    })

    test('re-encrypts the copied key freshly while keeping the same material', async () => {
      const created = await createConnection()

      await iroha.fetch(`${BASE}/${created.id}/duplicate`, { method: 'POST', csrf })

      const connections = await iroha.database.providers.listProviders()
      expect(connections).toHaveLength(2)

      const stored = []
      for (const connection of connections) {
        const [key] = await iroha.database.providers.listKeys(connection.id)
        stored.push(key!.encryptedKey)
      }

      expect(stored[0]).not.toBe(stored[1])

      const cipher = createSecretCipher(TEST_MASTER_KEY)
      for (const encrypted of stored) {
        expect(await cipher.decrypt(encrypted)).toBe(UPSTREAM_KEY)
      }
    })

    test('tests the copied key, and keeps it Unverified when the test is inconclusive', async () => {
      const created = await createConnection()
      probe.respondWith({ verdict: 'inconclusive', reason: 'the provider could not be reached' })

      const response = await iroha.fetch(`${BASE}/${created.id}/duplicate`, {
        method: 'POST',
        csrf,
      })

      const copy = (await response.json()) as ConnectionBody
      expect(copy.keys[0]?.health).toBe('unverified')
      expect(copy.keys[0]?.lastProbe?.verdict).toBe('inconclusive')
    })

    test('duplicating an archived connection returns the copy to active use', async () => {
      const created = await createConnection()
      await iroha.fetch(`${BASE}/${created.id}/archive`, { method: 'POST', csrf })

      const response = await iroha.fetch(`${BASE}/${created.id}/duplicate`, {
        method: 'POST',
        csrf,
      })

      expect(response.status).toBe(201)

      const copy = (await response.json()) as ConnectionBody
      expect(copy.archived).toBe(false)
      expect(copy.enabled).toBe(true)
    })
  })

  describe('secret non-disclosure', () => {
    test('no administrative response over the whole lifecycle echoes the key', async () => {
      const responses: Response[] = []

      const created = await createConnection()
      const keyId = created.keys[0]!.id

      responses.push(await createRequest({ displayName: 'Second' }))
      responses.push(await iroha.fetch(BASE))
      responses.push(await iroha.fetch(`${BASE}/${created.id}`))
      responses.push(
        await iroha.fetch(`${BASE}/${created.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: body({ displayName: 'Renamed' }),
          csrf,
        }),
      )
      responses.push(await iroha.fetch(`${BASE}/${created.id}/keys/${keyId}/test`, { method: 'POST', csrf }))
      responses.push(
        await iroha.fetch(`${BASE}/${created.id}/keys/${keyId}/disable`, { method: 'POST', csrf }),
      )
      responses.push(
        await iroha.fetch(`${BASE}/${created.id}/keys/${keyId}/activate`, { method: 'POST', csrf }),
      )
      responses.push(await iroha.fetch(`${BASE}/${created.id}/archive`, { method: 'POST', csrf }))
      responses.push(await iroha.fetch(`${BASE}/${created.id}/duplicate`, { method: 'POST', csrf }))
      responses.push(await iroha.fetch(`${BASE}/${created.id}/purge`, { method: 'POST', csrf }))

      for (const response of responses) {
        expect(await response.text()).not.toContain(UPSTREAM_KEY)
      }
    })

    test('audit history never carries the key', async () => {
      const created = await createConnection()
      await iroha.fetch(`${BASE}/${created.id}/archive`, { method: 'POST', csrf })
      await iroha.fetch(`${BASE}/${created.id}/purge`, { method: 'POST', csrf })

      const events = await iroha.database.audit.list()
      expect(events.length).toBeGreaterThan(0)

      for (const event of events) {
        expect(JSON.stringify(event.detail ?? null)).not.toContain(UPSTREAM_KEY)
      }
    })

    test('every stored key is encrypted and decrypts only with the master key', async () => {
      await createConnection()
      await createConnection({ displayName: 'Another' })

      const connections = await iroha.database.providers.listProviders()
      const cipher = createSecretCipher(TEST_MASTER_KEY)
      const wrongCipher = createSecretCipher('a-different-master-key-0123456789abcdef')

      for (const connection of connections) {
        const [key] = await iroha.database.providers.listKeys(connection.id)
        expect(key!.encryptedKey).not.toContain(UPSTREAM_KEY)
        expect(await cipher.decrypt(key!.encryptedKey)).toBe(UPSTREAM_KEY)
        await expect(wrongCipher.decrypt(key!.encryptedKey)).rejects.toThrow()
      }
    })
  })

  describe('generated API documentation', () => {
    test('represents the admin Provider Connection surface', async () => {
      const document = (await (await iroha.fetch('/docs/json')).json()) as {
        paths?: Record<string, unknown>
      }

      const paths = Object.keys(document.paths ?? {})

      expect(paths).toEqual(
        expect.arrayContaining([
          '/api/v1/admin/provider-connections',
          '/api/v1/admin/provider-connections/{id}',
          '/api/v1/admin/provider-connections/{id}/archive',
          '/api/v1/admin/provider-connections/{id}/duplicate',
          '/api/v1/admin/provider-connections/{id}/purge',
          '/api/v1/admin/provider-connections/{id}/keys/{keyId}/test',
          '/api/v1/admin/provider-connections/{id}/keys/{keyId}/activate',
          '/api/v1/admin/provider-connections/{id}/keys/{keyId}/disable',
        ]),
      )

      const createdPath = document.paths?.['/api/v1/admin/provider-connections'] as {
        post?: { responses?: Record<string, unknown> }
      }
      expect(Object.keys(createdPath.post?.responses ?? {})).toEqual(
        expect.arrayContaining(['201', '400', '401', '403']),
      )
    })
  })
})

async function errorOf(
  response: Response,
): Promise<{ code: string; problems: { field: string; message: string }[] }> {
  const body = (await response.json()) as {
    error?: { code?: string; problems?: { field: string; message: string }[] }
  }
  return { code: body.error?.code ?? '(no error code)', problems: body.error?.problems ?? [] }
}

async function problemsOf(response: Response): Promise<{ field: string; message: string }[]> {
  return (await errorOf(response)).problems
}
