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
const BASE = '/api/v1/admin/providers'
const OLD_BASE = '/api/v1/admin/provider-connections'
const KEY_BASE_URL = 'https://key.example.com/v1'

interface ProviderBody {
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
    health:
      | 'unverified'
      | 'active'
      | 'cooling_down'
      | 'invalid_authentication'
      | 'exhausted'
      | 'disabled'
    baseUrl: string | null
    effectiveBaseUrl: string
    lastProbe: { at: string; verdict: string; reason: string | null } | null
    createdAt: string
    updatedAt: string
  }[]
  accounts: {
    id: string
    displayName: string
    createdAt: string
    updatedAt: string
  }[]
}

describe('Provider administration', () => {
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
      body: JSON.stringify({
        displayName: 'Example',
        baseUrl: BASE_URL,
        keys: [{ upstreamKey: UPSTREAM_KEY }],
        ...fields,
      }),
      csrf,
    })

  const createProvider = async (fields: Record<string, unknown> = {}): Promise<ProviderBody> => {
    const response = await createRequest(fields)
    if (response.status !== 201) {
      throw new Error(`Create failed with ${response.status}: ${await response.text()}`)
    }
    return (await response.json()) as ProviderBody
  }

  const body = (data: Record<string, unknown>) => JSON.stringify(data)

  describe('route naming', () => {
    test('the old /provider-connections path is gone, no redirect', async () => {
      // The rename is hard-cut: callers still pointing at the old URL must
      // learn the answer is 404, not a redirect they could follow blindly.
      const response = await iroha.fetch(OLD_BASE)
      expect(response.status).toBe(404)
      expect(response.headers.get('location')).toBeNull()
    })

    test('POST to the old /provider-connections path returns 404', async () => {
      const response = await iroha.fetch(OLD_BASE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body({ displayName: 'Example', baseUrl: BASE_URL, keys: [{ upstreamKey: UPSTREAM_KEY }] }),
      })
      expect(response.status).toBe(404)
    })

    test('a stale sub-path under the old prefix is also 404', async () => {
      const response = await iroha.fetch(`${OLD_BASE}/pr_anything/purge`, {
        method: 'POST',
      })
      expect(response.status).toBe(404)
    })

    test('the new /providers path answers', async () => {
      const response = await iroha.fetch(BASE)
      expect(response.status).toBe(200)
    })
  })

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
        body: body({ displayName: 'Example', baseUrl: BASE_URL, keys: [{ upstreamKey: UPSTREAM_KEY }] }),
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
      expect((await iroha.fetch(`${BASE}/pr_absent`)).status).toBe(404)
    })
  })

  describe('creation', () => {
    test('creates a Provider with an immutable ID and one encrypted key', async () => {
      const created = await createProvider()

      expect(created.id).toMatch(/^pr_/)
      expect(created.displayName).toBe('Example')
      expect(created.baseUrl).toBe(BASE_URL)
      expect(created.allowInsecureHttp).toBe(false)
      expect(created.enabled).toBe(true)
      expect(created.archived).toBe(false)
      expect(created.keys).toHaveLength(1)

      const [key] = created.keys
      expect(key?.id).toMatch(/^uk_/)
      expect(key?.health).toBe('active')
      expect(key?.lastProbe).toMatchObject({ verdict: 'authenticated', reason: null })
    })

    test('sends the submitted key to the provider seam, not to storage', async () => {
      await createProvider()

      expect(probe.calls).toEqual([{ baseUrl: BASE_URL, upstreamKey: UPSTREAM_KEY }])
    })

    test('creates a Provider with two keys, each tested against its own base URL', async () => {
      const created = await createProvider({
        keys: [
          { upstreamKey: UPSTREAM_KEY },
          { upstreamKey: 'sk-second-upstream-key-for-tests', baseUrl: KEY_BASE_URL },
        ],
      })

      expect(created.keys).toHaveLength(2)
      const probeCalls = probe.calls.map((call) => ({ ...call }))
      expect(probeCalls).toEqual(
        expect.arrayContaining([
          { baseUrl: BASE_URL, upstreamKey: UPSTREAM_KEY },
          { baseUrl: KEY_BASE_URL, upstreamKey: 'sk-second-upstream-key-for-tests' },
        ]),
      )

      const overrideKey = created.keys.find((key) => key.baseUrl === KEY_BASE_URL)
      expect(overrideKey?.effectiveBaseUrl).toBe(KEY_BASE_URL)
    })

    test('writes a key.created audit event for each key supplied at creation', async () => {
      await createProvider({
        keys: [
          { upstreamKey: UPSTREAM_KEY },
          { upstreamKey: 'sk-second-upstream-key-for-tests', baseUrl: KEY_BASE_URL },
        ],
      })

      const events = await iroha.database.audit.list()
      const createEvents = events.filter((event) => event.action === 'key.created')
      expect(createEvents).toHaveLength(2)
      expect(
        createEvents.every(
          (event) =>
            Array.isArray(event.detail) === false &&
            typeof event.detail === 'object' &&
            event.detail !== null &&
            'providerId' in event.detail,
        ),
      ).toBe(true)
    })

    test('a blank per-key baseUrl at creation inherits the Provider default', async () => {
      const created = await createProvider({
        keys: [{ upstreamKey: UPSTREAM_KEY, baseUrl: '   ' }],
      })

      expect(created.keys[0]?.baseUrl).toBeNull()
      expect(created.keys[0]?.effectiveBaseUrl).toBe(BASE_URL)
    })

    test('keeps a usable probe result and activates the key on creation', async () => {
      probe.respondWith({ verdict: 'authenticated', reason: null })

      const created = await createProvider()

      expect(created.keys[0]?.health).toBe('active')
    })

    test('demotes the key to cooling_down with its reason after an inconclusive test', async () => {
      probe.respondWith({
        verdict: 'inconclusive',
        reason: 'the provider rate-limited the test (HTTP 429)',
      })

      const created = await createProvider()

      expect(created.keys[0]?.health).toBe('cooling_down')
      expect(created.keys[0]?.lastProbe).toMatchObject({
        verdict: 'inconclusive',
        reason: 'the provider rate-limited the test (HTTP 429)',
      })
    })

    test('demotes the key to invalid_authentication after the provider rejects it', async () => {
      probe.respondWith({ verdict: 'rejected', reason: 'the provider rejected the key (HTTP 401)' })

      const created = await createProvider()

      expect(created.keys[0]?.health).toBe('invalid_authentication')
      expect(created.keys[0]?.lastProbe?.verdict).toBe('rejected')
    })

    test('survives a probe that throws and demotes the key to cooling_down', async () => {
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
          body: body({ displayName: 'Example', baseUrl: BASE_URL, keys: [{ upstreamKey: UPSTREAM_KEY }] }),
          csrf: signedIn.csrf,
        })

        const created = (await response.json()) as ProviderBody
        expect(response.status).toBe(201)
        expect(created.keys[0]?.health).toBe('cooling_down')
        expect(created.keys[0]?.lastProbe?.reason).toBe('the key test did not complete')
      } finally {
        await app.dispose()
      }
    })

    test('encrypts the key at rest with the installation master key', async () => {
      await createProvider()

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
      probe.respondWith({ verdict: 'authenticated', reason: null })

      const created = await createProvider({
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
        body: body({ displayName: '', baseUrl: 'not a url', keys: [{ upstreamKey: '' }] }),
        csrf,
      })

      expect(response.status).toBe(400)

      const problems = await problemsOf(response)
      expect(problems.map((problem) => problem.field).sort()).toEqual([
        'baseUrl',
        'displayName',
        'keys[0].upstreamKey',
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
      const response = await createRequest({ keys: [{ upstreamKey: 'k'.repeat(2049) }] })

      expect(response.status).toBe(400)

      const failure = await errorOf(response)
      expect(failure.code).toBe('validation_failed')
      expect(failure.problems.map((problem) => problem.field)).toEqual(['keys[0].upstreamKey'])
    })

    test('refuses an empty keys array', async () => {
      const response = await createRequest({ keys: [] })

      expect(response.status).toBe(400)

      const failure = await errorOf(response)
      expect(failure.code).toBe('validation_failed')
      expect(failure.problems.map((problem) => problem.field)).toEqual(['keys'])
    })

    test('refuses a non-array keys value', async () => {
      const response = await createRequest({ keys: 'not an array' })

      expect(response.status).toBe(400)

      const failure = await errorOf(response)
      expect(failure.code).toBe('validation_failed')
      expect(failure.problems.map((problem) => problem.field)).toEqual(['keys'])
    })

    test('refuses an entry that is not an object', async () => {
      const response = await createRequest({ keys: ['sk-bad'] })

      expect(response.status).toBe(400)

      const failure = await errorOf(response)
      expect(failure.code).toBe('validation_failed')
      expect(failure.problems.map((problem) => problem.field)).toEqual(['keys[0]'])
    })

    test('refuses an invalid per-key baseUrl, tagging the offending row', async () => {
      const response = await createRequest({ keys: [{ upstreamKey: UPSTREAM_KEY, baseUrl: 'not a url' }] })

      expect(response.status).toBe(400)

      const failure = await errorOf(response)
      expect(failure.code).toBe('validation_failed')
      expect(failure.problems.map((problem) => problem.field)).toEqual(['keys[0].baseUrl'])
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
    test('lists Providers created before the authenticated Credential Evidence rename', async () => {
      const created = await createProvider()
      const key = await iroha.database.providers.getKey(created.keys[0]!.id)
      expect(key).not.toBeNull()
      await iroha.database.providers.updateKey(
        created.keys[0]!.id,
        { lastProbeVerdict: 'usable' as never },
        new Date(),
      )

      const response = await iroha.fetch(BASE)

      expect(response.status).toBe(200)
      const payload = await response.json() as { providers: ProviderBody[] }
      expect(payload.providers[0]?.keys[0]?.lastProbe?.verdict).toBe('authenticated')
    })

    test('lists every Provider, most recently created first', async () => {
      const first = await createProvider({ displayName: 'First' })
      iroha.clock.advance(60)
      const second = await createProvider({ displayName: 'Second' })

      const listed = (await (await iroha.fetch(BASE)).json()) as { providers: ProviderBody[] }

      expect(listed.providers.map((provider) => provider.id)).toEqual([second.id, first.id])
    })

    test('inspects one Provider by its immutable ID', async () => {
      const created = await createProvider({ displayName: 'Named' })

      const response = await iroha.fetch(`${BASE}/${created.id}`)

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(created)
    })

    test('reports an unknown Provider', async () => {
      const response = await iroha.fetch(`${BASE}/pr_absent`)

      expect(response.status).toBe(404)
      expect(await errorCode(response)).toBe('provider_not_found')
    })
  })

  describe('editing', () => {
    test('edits the display name and base URL without touching the ID', async () => {
      const created = await createProvider()
      iroha.clock.advance(30)

      const response = await iroha.fetch(`${BASE}/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: body({ displayName: 'Renamed', baseUrl: 'https://other.example.com/v1' }),
        csrf,
      })

      expect(response.status).toBe(200)

      const updated = (await response.json()) as ProviderBody
      expect(updated.id).toBe(created.id)
      expect(updated.displayName).toBe('Renamed')
      expect(updated.baseUrl).toBe('https://other.example.com/v1')
      // The Key inherits the Provider's default base URL, which the edit just
      // changed. The Key's identity and health are unaffected.
      expect(updated.keys[0]?.id).toBe(created.keys[0]?.id)
      expect(updated.keys[0]?.effectiveBaseUrl).toBe('https://other.example.com/v1')
    })

    test('toggles the enabled state', async () => {
      const created = await createProvider()

      await iroha.fetch(`${BASE}/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: body({ enabled: false }),
        csrf,
      })

      const stored = await iroha.database.providers.getProvider(created.id)
      expect(stored?.enabled).toBe(false)
    })

    test('refuses to move a live Provider onto plain HTTP without the exception', async () => {
      const created = await createProvider()

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
      const created = await createProvider({
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

    test('reports an unknown Provider', async () => {
      const response = await iroha.fetch(`${BASE}/pr_absent`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: body({ displayName: 'Nope' }),
        csrf,
      })

      expect(response.status).toBe(404)
      expect(await errorCode(response)).toBe('provider_not_found')
    })

    test('audits which fields changed, not what they changed to', async () => {
      const created = await createProvider()

      await iroha.fetch(`${BASE}/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: body({ displayName: 'Renamed', baseUrl: 'https://other.example.com/v1' }),
        csrf,
      })

      const events = await iroha.database.audit.list()
      const updated = events.find((event) => event.action === 'provider.updated')

      expect(updated?.detail).toEqual({
        providerId: created.id,
        fields: ['displayName', 'baseUrl'],
      })
    })
  })

  describe('key actions', () => {
    test('manually activates an inconclusively tested key', async () => {
      probe.respondWith({ verdict: 'inconclusive', reason: 'the provider could not be reached' })
      const created = await createProvider()

      const keyId = created.keys[0]!.id
      const response = await iroha.fetch(`${BASE}/${created.id}/keys/${keyId}/activate`, {
        method: 'POST',
        csrf,
      })

      expect(response.status).toBe(200)

      const updated = (await response.json()) as ProviderBody
      expect(updated.keys[0]?.health).toBe('active')
      expect(updated.keys[0]?.lastProbe?.reason).toBe('the provider could not be reached')
    })

    test('a usable retest activates a key that an inconclusive probe demoted to cooling_down', async () => {
      probe.respondWith({ verdict: 'inconclusive', reason: 'the provider could not be reached' })
      const created = await createProvider()

      probe.respondWith({ verdict: 'authenticated', reason: null })
      const keyId = created.keys[0]!.id
      const response = await iroha.fetch(`${BASE}/${created.id}/keys/${keyId}/test`, {
        method: 'POST',
        csrf,
      })

      const updated = (await response.json()) as ProviderBody
      expect(response.status).toBe(200)
      expect(updated.keys[0]?.health).toBe('active')
      expect(updated.keys[0]?.lastProbe).toMatchObject({ verdict: 'authenticated', reason: null })
    })

    test('retesting a Disabled key records the outcome but keeps it disabled', async () => {
      const created = await createProvider()
      const keyId = created.keys[0]!.id

      await iroha.fetch(`${BASE}/${created.id}/keys/${keyId}/disable`, { method: 'POST', csrf })

      probe.respondWith({ verdict: 'authenticated', reason: null })
      const response = await iroha.fetch(`${BASE}/${created.id}/keys/${keyId}/test`, {
        method: 'POST',
        csrf,
      })

      const updated = (await response.json()) as ProviderBody
      expect(updated.keys[0]?.health).toBe('disabled')
      expect(updated.keys[0]?.lastProbe?.verdict).toBe('authenticated')
    })

    test('disable and activate are audited without secret values', async () => {
      const created = await createProvider()
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

    test('refuses a key that does not belong to the Provider', async () => {
      const created = await createProvider()

      const response = await iroha.fetch(`${BASE}/${created.id}/keys/uk_absent/test`, {
        method: 'POST',
        csrf,
      })

      expect(response.status).toBe(404)
      expect(await errorCode(response)).toBe('key_not_found')
    })

    test('adds a key with an optional per-key base URL override', async () => {
      const created = await createProvider()

      const response = await iroha.fetch(`${BASE}/${created.id}/keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body({ upstreamKey: UPSTREAM_KEY, baseUrl: KEY_BASE_URL }),
        csrf,
      })
      expect(response.status).toBe(201)

      const updated = (await response.json()) as ProviderBody
      expect(updated.keys).toHaveLength(2)
      const newKey = updated.keys.find((key) => key.id !== created.keys[0]!.id)!
      expect(newKey.baseUrl).toBe(KEY_BASE_URL)
      expect(newKey.effectiveBaseUrl).toBe(KEY_BASE_URL)
    })

    test('a blank baseUrl on add inherits the Provider default', async () => {
      const created = await createProvider()
      const response = await iroha.fetch(`${BASE}/${created.id}/keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body({ upstreamKey: UPSTREAM_KEY, baseUrl: '   ' }),
        csrf,
      })
      expect(response.status).toBe(201)

      const updated = (await response.json()) as ProviderBody
      const newKey = updated.keys.find((key) => key.id !== created.keys[0]!.id)!
      expect(newKey.baseUrl).toBeNull()
      expect(newKey.effectiveBaseUrl).toBe(BASE_URL)
    })

    test('omitting baseUrl on add inherits the Provider default', async () => {
      const created = await createProvider()
      const response = await iroha.fetch(`${BASE}/${created.id}/keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body({ upstreamKey: UPSTREAM_KEY }),
        csrf,
      })
      expect(response.status).toBe(201)

      const updated = (await response.json()) as ProviderBody
      const newKey = updated.keys.find((key) => key.id !== created.keys[0]!.id)!
      expect(newKey.baseUrl).toBeNull()
      expect(newKey.effectiveBaseUrl).toBe(BASE_URL)
    })

    test('rejects an invalid per-key baseUrl at add time', async () => {
      const created = await createProvider()
      const response = await iroha.fetch(`${BASE}/${created.id}/keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body({ upstreamKey: UPSTREAM_KEY, baseUrl: 'not a url' }),
        csrf,
      })
      expect(response.status).toBe(400)
      const failure = await errorOf(response)
      expect(failure.code).toBe('validation_failed')
      expect(failure.problems.map((problem) => problem.field)).toEqual(['baseUrl'])
    })

    test('updates a per-key base URL override on the existing key', async () => {
      const created = await createProvider()
      const keyId = created.keys[0]!.id

      const response = await iroha.fetch(`${BASE}/${created.id}/keys/${keyId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: body({ baseUrl: KEY_BASE_URL }),
        csrf,
      })
      expect(response.status).toBe(200)

      const updated = (await response.json()) as ProviderBody
      expect(updated.keys[0]?.baseUrl).toBe(KEY_BASE_URL)
      expect(updated.keys[0]?.effectiveBaseUrl).toBe(KEY_BASE_URL)
    })

    test('a blank baseUrl on patch clears the override and falls back to the Provider default', async () => {
      const created = await createProvider()
      const keyId = created.keys[0]!.id

      await iroha.fetch(`${BASE}/${created.id}/keys/${keyId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: body({ baseUrl: KEY_BASE_URL }),
        csrf,
      })

      const response = await iroha.fetch(`${BASE}/${created.id}/keys/${keyId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: body({ baseUrl: '' }),
        csrf,
      })
      expect(response.status).toBe(200)

      const updated = (await response.json()) as ProviderBody
      expect(updated.keys[0]?.baseUrl).toBeNull()
      expect(updated.keys[0]?.effectiveBaseUrl).toBe(BASE_URL)
    })

    test('audits per-key base URL changes without echoing the URL', async () => {
      const created = await createProvider()
      const keyId = created.keys[0]!.id

      await iroha.fetch(`${BASE}/${created.id}/keys/${keyId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: body({ baseUrl: KEY_BASE_URL }),
        csrf,
      })

      const events = await iroha.database.audit.list()
      const configured = events.find((event) => event.action === 'key.configured')
      expect(configured?.detail).toEqual({
        providerId: created.id,
        keyId,
        fields: ['baseUrl'],
      })
    })
  })

  describe('archive and purge', () => {
    test('archiving disables the Provider but preserves its identity', async () => {
      const created = await createProvider()
      iroha.clock.advance(30)

      const response = await iroha.fetch(`${BASE}/${created.id}/archive`, { method: 'POST', csrf })

      expect(response.status).toBe(200)

      const archived = (await response.json()) as ProviderBody
      expect(archived.id).toBe(created.id)
      expect(archived.archived).toBe(true)
      expect(archived.enabled).toBe(false)
      expect(archived.keys).toEqual(created.keys)
    })

    test('archiving twice changes nothing the second time', async () => {
      const created = await createProvider()

      await iroha.fetch(`${BASE}/${created.id}/archive`, { method: 'POST', csrf })
      const second = await iroha.fetch(`${BASE}/${created.id}/archive`, { method: 'POST', csrf })

      expect(second.status).toBe(200)
      expect(((await second.json()) as ProviderBody).archived).toBe(true)
    })

    test('an archived Provider refuses edits and key actions', async () => {
      const created = await createProvider()
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
        expect(await errorCode(response)).toBe('provider_archived')
      }
    })

    test('refuses to purge a Provider before it is archived', async () => {
      const created = await createProvider()

      const refused = await iroha.fetch(`${BASE}/${created.id}/purge`, { method: 'POST', csrf })

      expect(refused.status).toBe(409)
      expect(await errorCode(refused)).toBe('not_archived')
      expect(await iroha.database.providers.getProvider(created.id)).not.toBeNull()
    })

    test('purge removes an archived Provider and its keys permanently', async () => {
      const created = await createProvider()
      await iroha.fetch(`${BASE}/${created.id}/archive`, { method: 'POST', csrf })

      const response = await iroha.fetch(`${BASE}/${created.id}/purge`, { method: 'POST', csrf })

      expect(response.status).toBe(204)
      expect(await iroha.database.providers.getProvider(created.id)).toBeNull()
      expect(await iroha.database.providers.listKeys(created.id)).toEqual([])
      expect((await iroha.fetch(`${BASE}/${created.id}`)).status).toBe(404)
    })

    test('purging an absent Provider reports it', async () => {
      const response = await iroha.fetch(`${BASE}/pr_absent/purge`, { method: 'POST', csrf })

      expect(response.status).toBe(404)
      expect(await errorCode(response)).toBe('provider_not_found')
    })
  })

  describe('duplication', () => {
    test('duplicates under a new identity without touching the original', async () => {
      const created = await createProvider({ displayName: 'Original' })

      const response = await iroha.fetch(`${BASE}/${created.id}/duplicate`, {
        method: 'POST',
        csrf,
      })

      expect(response.status).toBe(201)

      const copy = (await response.json()) as ProviderBody
      expect(copy.id).not.toBe(created.id)
      expect(copy.id).toMatch(/^pr_/)
      expect(copy.displayName).toBe('Original (copy)')
      expect(copy.baseUrl).toBe(created.baseUrl)
      expect(copy.archived).toBe(false)
      expect(copy.enabled).toBe(true)
      expect(copy.keys[0]?.id).not.toBe(created.keys[0]?.id)
      expect(copy.keys[0]?.health).toBe('active')

      const original = (await (await iroha.fetch(`${BASE}/${created.id}`)).json()) as ProviderBody
      expect(original.displayName).toBe('Original')
    })

    test('re-encrypts the copied key freshly while keeping the same material', async () => {
      const created = await createProvider()

      await iroha.fetch(`${BASE}/${created.id}/duplicate`, { method: 'POST', csrf })

      const providers = await iroha.database.providers.listProviders()
      expect(providers).toHaveLength(2)

      const stored = []
      for (const provider of providers) {
        const [key] = await iroha.database.providers.listKeys(provider.id)
        stored.push(key!.encryptedKey)
      }

      expect(stored[0]).not.toBe(stored[1])

      const cipher = createSecretCipher(TEST_MASTER_KEY)
      for (const encrypted of stored) {
        expect(await cipher.decrypt(encrypted)).toBe(UPSTREAM_KEY)
      }
    })

    test('tests the copied key, and demotes it to cooling_down when the test is inconclusive', async () => {
      const created = await createProvider()
      probe.respondWith({ verdict: 'inconclusive', reason: 'the provider could not be reached' })

      const response = await iroha.fetch(`${BASE}/${created.id}/duplicate`, {
        method: 'POST',
        csrf,
      })

      const copy = (await response.json()) as ProviderBody
      expect(copy.keys[0]?.health).toBe('cooling_down')
      expect(copy.keys[0]?.lastProbe?.verdict).toBe('inconclusive')
    })

    test('duplicating an archived Provider returns the copy to active use', async () => {
      const created = await createProvider()
      await iroha.fetch(`${BASE}/${created.id}/archive`, { method: 'POST', csrf })

      const response = await iroha.fetch(`${BASE}/${created.id}/duplicate`, {
        method: 'POST',
        csrf,
      })

      expect(response.status).toBe(201)

      const copy = (await response.json()) as ProviderBody
      expect(copy.archived).toBe(false)
      expect(copy.enabled).toBe(true)
    })
  })

  describe('secret non-disclosure', () => {
    test('no administrative response over the whole lifecycle echoes the key', async () => {
      const responses: Response[] = []

      const created = await createProvider()
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
      const created = await createProvider()
      await iroha.fetch(`${BASE}/${created.id}/archive`, { method: 'POST', csrf })
      await iroha.fetch(`${BASE}/${created.id}/purge`, { method: 'POST', csrf })

      const events = await iroha.database.audit.list()
      expect(events.length).toBeGreaterThan(0)

      for (const event of events) {
        expect(JSON.stringify(event.detail ?? null)).not.toContain(UPSTREAM_KEY)
      }
    })

    test('every stored key is encrypted and decrypts only with the master key', async () => {
      await createProvider()
      await createProvider({ displayName: 'Another' })

      const providers = await iroha.database.providers.listProviders()
      const cipher = createSecretCipher(TEST_MASTER_KEY)
      const wrongCipher = createSecretCipher('a-different-master-key-0123456789abcdef')

      for (const provider of providers) {
        const [key] = await iroha.database.providers.listKeys(provider.id)
        expect(key!.encryptedKey).not.toContain(UPSTREAM_KEY)
        expect(await cipher.decrypt(key!.encryptedKey)).toBe(UPSTREAM_KEY)
        await expect(wrongCipher.decrypt(key!.encryptedKey)).rejects.toThrow()
      }
    })
  })

  describe('generated API documentation', () => {
    test('represents the admin Provider surface', async () => {
      const document = (await (await iroha.fetch('/docs/json')).json()) as {
        paths?: Record<string, unknown>
      }

      const paths = Object.keys(document.paths ?? {})

      expect(paths).toEqual(
        expect.arrayContaining([
          '/api/v1/admin/providers',
          '/api/v1/admin/providers/{id}',
          '/api/v1/admin/providers/{id}/archive',
          '/api/v1/admin/providers/{id}/duplicate',
          '/api/v1/admin/providers/{id}/purge',
          '/api/v1/admin/providers/{id}/keys/{keyId}/test',
          '/api/v1/admin/providers/{id}/keys/{keyId}/activate',
          '/api/v1/admin/providers/{id}/keys/{keyId}/disable',
        ]),
      )

      const createdPath = document.paths?.['/api/v1/admin/providers'] as {
        post?: { responses?: Record<string, unknown> }
      }
      expect(Object.keys(createdPath.post?.responses ?? {})).toEqual(
        expect.arrayContaining(['201', '400', '401', '403']),
      )
    })

    test('no longer documents the old provider-connections paths', async () => {
      const document = (await (await iroha.fetch('/docs/json')).json()) as {
        paths?: Record<string, unknown>
      }

      const paths = Object.keys(document.paths ?? {})
      expect(paths.some((path) => path.includes('/admin/provider-connections'))).toBe(false)
    })
  })

  describe('audit vocabulary after the Provider rename', () => {
    // The Owner-facing rename from "Provider Connection" to "Provider" must
    // touch the audit vocabulary the same way it touches every other layer:
    // no new code is allowed to write a `connection.*` action. Pre-rename
    // rows in the audit table are append-only history and keep their old
    // action names, but every action written from now on lives under the
    // `provider.*`, `key.*`, or `account.*` prefixes. A regression that
    // reintroduces a `connection.*` action would silently show up in the
    // Owner's audit feed years after the rename, so this pins the contract.
    //
    // The exercise walks every action name the spec enumerates so a code
    // path that drifts back to a `connection.*` prefix trips the assertion
    // here rather than at one of the narrower single-action tests.
    test('the full Owner lifecycle writes only provider.*, key.*, and account.* actions', async () => {
      const created = await createProvider()
      const providerId = created.id
      const [firstKey] = created.keys

      // provider.created (the createProvider above) and provider.updated.
      await iroha.fetch(`${BASE}/${providerId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: body({ displayName: 'Renamed for audit' }),
        csrf,
      })

      // key.created (a freshly-added Upstream Key), key.tested,
      // key.disabled, key.activated, key.configured.
      const secondKeyResponse = await iroha.fetch(`${BASE}/${providerId}/keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body({ upstreamKey: 'sk-second-upstream-key-for-tests' }),
        csrf,
      })
      expect(secondKeyResponse.status).toBe(201)
      const afterAdd = (await secondKeyResponse.json()) as ProviderBody
      const secondKey = afterAdd.keys[afterAdd.keys.length - 1]!
      await iroha.fetch(`${BASE}/${providerId}/keys/${secondKey.id}/test`, {
        method: 'POST',
        csrf,
      })
      await iroha.fetch(`${BASE}/${providerId}/keys/${firstKey!.id}/disable`, {
        method: 'POST',
        csrf,
      })
      await iroha.fetch(`${BASE}/${providerId}/keys/${firstKey!.id}/activate`, {
        method: 'POST',
        csrf,
      })
      await iroha.fetch(`${BASE}/${providerId}/keys/${firstKey!.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: body({ allowedModels: ['gpt-4o-mini'] }),
        csrf,
      })

      // account.created and account.removed.
      const accountResponse = await iroha.fetch(`${BASE}/${providerId}/accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body({ displayName: 'Shared billing' }),
        csrf,
      })
      expect(accountResponse.status).toBe(201)
      const accountBody = (await accountResponse.json()) as ProviderBody
      const accountId = accountBody.accounts[0]!.id
      const deleteAccountResponse = await iroha.fetch(
        `${BASE}/${providerId}/accounts/${accountId}`,
        { method: 'DELETE', csrf },
      )
      expect(deleteAccountResponse.status).toBe(200)

      // provider.duplicated. The duplicate's first key writes key.created.
      const duplicateResponse = await iroha.fetch(`${BASE}/${providerId}/duplicate`, {
        method: 'POST',
        csrf,
      })
      expect(duplicateResponse.status).toBe(201)
      const duplicateBody = (await duplicateResponse.json()) as ProviderBody
      const duplicateId = duplicateBody.id

      // provider.archived.
      await iroha.fetch(`${BASE}/${providerId}/archive`, { method: 'POST', csrf })

      // provider.purged. Purging an archived Provider is allowed and
      // emits the terminal audit action; the duplicate stays in the
      // schema so its lifetime is visible.
      await iroha.fetch(`${BASE}/${providerId}/purge`, { method: 'POST', csrf })

      // key.removed. Removing the duplicate's only key tests that path.
      const [duplicateKey] = duplicateBody.keys
      await iroha.fetch(`${BASE}/${duplicateId}/keys/${duplicateKey!.id}`, {
        method: 'DELETE',
        csrf,
      })

      const actions = (await iroha.database.audit.list()).map((event) => event.action)
      const connectionActions = actions.filter((action) => action.startsWith('connection.'))

      expect(connectionActions).toEqual([])

      // The exercise above must produce each prefix, so a future refactor
      // that drops the action-name contract entirely trips an assertion
      // here rather than producing an empty audit feed.
      const providerActions = actions.filter((action) => action.startsWith('provider.'))
      const keyActions = actions.filter((action) => action.startsWith('key.'))
      const accountActions = actions.filter((action) => action.startsWith('account.'))
      expect(providerActions.length).toBeGreaterThan(0)
      expect(keyActions.length).toBeGreaterThan(0)
      expect(accountActions.length).toBeGreaterThan(0)

      // The exercise covers every action the spec calls out: a regression
      // that drops any one of them would otherwise pass a narrower test.
      for (const required of [
        'provider.created',
        'provider.updated',
        'provider.archived',
        'provider.duplicated',
        'provider.purged',
        'key.created',
        'key.tested',
        'key.disabled',
        'key.activated',
        'key.configured',
        'key.removed',
        'account.created',
        'account.removed',
      ]) {
        expect(actions).toContain(required)
      }
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
