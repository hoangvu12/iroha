import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  completeSetup,
  createTestApp,
  errorCode,
  fakeKeyProbe,
  type FakeKeyProbe,
  type TestApp,
} from '../support/app.ts'

const UPSTREAM_KEY = 'sk-upstream-secret-value-for-tests'
const BASE_URL = 'https://api.example.com/v1'
const BASE = '/api/v1/admin/provider-connections'

interface KeyBody {
  id: string
  health: 'unverified' | 'active' | 'disabled'
  lastProbe: { at: string; verdict: string; reason: string | null } | null
  accountId: string | null
  allowedModels: string[] | null
  deniedModels: string[] | null
  createdAt: string
  updatedAt: string
}

interface AccountBody {
  id: string
  displayName: string
  createdAt: string
  updatedAt: string
}

interface ConnectionBody {
  id: string
  displayName: string
  keys: KeyBody[]
  accounts: AccountBody[]
}

describe('Upstream Key pools and Upstream Accounts', () => {
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

  const createConnection = async (): Promise<ConnectionBody> => {
    const response = await iroha.fetch(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Example', baseUrl: BASE_URL, upstreamKey: UPSTREAM_KEY }),
      csrf,
    })
    if (response.status !== 201) {
      throw new Error(`Create failed with ${response.status}: ${await response.text()}`)
    }
    return (await response.json()) as ConnectionBody
  }

  const addKey = async (connectionId: string, upstreamKey: string = UPSTREAM_KEY) => {
    const response = await iroha.fetch(`${BASE}/${connectionId}/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upstreamKey }),
      csrf,
    })
    return response
  }

  const view = async (connectionId: string): Promise<ConnectionBody> =>
    (await (await iroha.fetch(`${BASE}/${connectionId}`)).json()) as ConnectionBody

  describe('many keys on one connection', () => {
    test('adds several tested keys beside the connection key', async () => {
      const created = await createConnection()
      expect(created.keys).toHaveLength(1)

      const second = await addKey(created.id)
      expect(second.status).toBe(201)
      expect((await second.json() as ConnectionBody).keys).toHaveLength(2)

      const third = await addKey(created.id)
      expect(third.status).toBe(201)

      const current = await view(created.id)
      expect(current.keys).toHaveLength(3)
      expect(current.keys[0]?.health).toBe('active')
      expect(current.keys[1]?.health).toBe('active')
      expect(current.keys[2]?.health).toBe('active')
      // Each key is encrypted with the same material but under a fresh identity.
      expect(new Set(current.keys.map((key) => key.id)).size).toBe(3)
    })

    test('an added key is Unverified when its test is inconclusive', async () => {
      probe.respondWith({ verdict: 'inconclusive', reason: 'the provider could not be reached' })
      const created = await createConnection()

      const second = await addKey(created.id)
      const current = (await second.json()) as ConnectionBody
      expect(current.keys[1]?.health).toBe('unverified')
      expect(current.keys[1]?.lastProbe?.verdict).toBe('inconclusive')
    })

    test('removes one key without touching the others', async () => {
      const created = await createConnection()
      await addKey(created.id)
      const current = await view(created.id)
      const removedId = current.keys[1]!.id

      const response = await iroha.fetch(`${BASE}/${created.id}/keys/${removedId}`, {
        method: 'DELETE',
        csrf,
      })

      expect(response.status).toBe(200)
      const after = (await response.json()) as ConnectionBody
      expect(after.keys).toHaveLength(1)
      expect(after.keys[0]?.id).toBe(current.keys[0]?.id)
      expect(await iroha.database.providers.getKey(removedId)).toBeNull()
    })

    test('disables, tests, and reactivates a key among several', async () => {
      const created = await createConnection()
      await addKey(created.id)
      const current = await view(created.id)
      const keyId = current.keys[1]!.id

      await iroha.fetch(`${BASE}/${created.id}/keys/${keyId}/disable`, { method: 'POST', csrf })
      expect((await view(created.id)).keys[1]?.health).toBe('disabled')

      probe.respondWith({ verdict: 'usable', reason: null })
      const tested = await iroha.fetch(`${BASE}/${created.id}/keys/${keyId}/test`, {
        method: 'POST',
        csrf,
      })
      expect(((await tested.json()) as ConnectionBody).keys[1]?.health).toBe('disabled')

      const activated = await iroha.fetch(`${BASE}/${created.id}/keys/${keyId}/activate`, {
        method: 'POST',
        csrf,
      })
      expect(((await activated.json()) as ConnectionBody).keys[1]?.health).toBe('active')
    })

    test('refuses an added key that is too long', async () => {
      const created = await createConnection()
      const response = await addKey(created.id, 'k'.repeat(2049))

      expect(response.status).toBe(400)
      expect(await errorCode(response)).toBe('validation_failed')
      expect((await view(created.id)).keys).toHaveLength(1)
    })

    test('refuses adding a key to an archived connection', async () => {
      const created = await createConnection()
      await iroha.fetch(`${BASE}/${created.id}/archive`, { method: 'POST', csrf })

      const response = await addKey(created.id)
      expect(response.status).toBe(409)
      expect(await errorCode(response)).toBe('connection_archived')
    })
  })

  describe('per-key model rules', () => {
    test('sets and clears allow and deny lists', async () => {
      const created = await createConnection()
      const keyId = created.keys[0]!.id

      const response = await iroha.fetch(`${BASE}/${created.id}/keys/${keyId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ allowedModels: ['gpt-4o', 'gpt-4o-mini'], deniedModels: ['o1-preview'] }),
        csrf,
      })

      expect(response.status).toBe(200)
      const configured = (await response.json()) as ConnectionBody
      expect(configured.keys[0]?.allowedModels).toEqual(['gpt-4o', 'gpt-4o-mini'])
      expect(configured.keys[0]?.deniedModels).toEqual(['o1-preview'])

      const stored = await iroha.database.providers.getKey(keyId)
      expect(stored?.allowedModels).toEqual(['gpt-4o', 'gpt-4o-mini'])
      expect(stored?.deniedModels).toEqual(['o1-preview'])
    })

    test('null lists mean no restriction and deduplicates repeated model IDs', async () => {
      const created = await createConnection()
      const keyId = created.keys[0]!.id

      const response = await iroha.fetch(`${BASE}/${created.id}/keys/${keyId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ allowedModels: ['gpt-4o', 'gpt-4o', '  gpt-4o-mini  '], deniedModels: null }),
        csrf,
      })

      const configured = (await response.json()) as ConnectionBody
      expect(configured.keys[0]?.allowedModels).toEqual(['gpt-4o', 'gpt-4o-mini'])
      expect(configured.keys[0]?.deniedModels).toBeNull()
    })

    test('rejects a malformed model list', async () => {
      const created = await createConnection()
      const keyId = created.keys[0]!.id

      const response = await iroha.fetch(`${BASE}/${created.id}/keys/${keyId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ allowedModels: 'gpt-4o' }),
        csrf,
      })

      expect(response.status).toBe(400)
      const body = (await response.json()) as { error?: { problems?: { field: string }[] } }
      expect(body.error?.problems?.[0]?.field).toBe('allowedModels')
    })

    test('audits key configuration with field names only', async () => {
      const created = await createConnection()
      const keyId = created.keys[0]!.id

      await iroha.fetch(`${BASE}/${created.id}/keys/${keyId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ allowedModels: ['gpt-4o'], deniedModels: ['o1'] }),
        csrf,
      })

      const event = (await iroha.database.audit.list()).find((entry) => entry.action === 'key.configured')
      expect(event?.detail).toEqual({
        connectionId: created.id,
        keyId,
        fields: ['allowedModels', 'deniedModels'],
      })
    })
  })

  describe('Upstream Accounts', () => {
    const createAccount = async (connectionId: string, displayName: string) => {
      const response = await iroha.fetch(`${BASE}/${connectionId}/accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName }),
        csrf,
      })
      return response
    }

    test('creates an account and groups keys into it', async () => {
      const created = await createConnection()

      const createdAccount = await createAccount(created.id, 'Shared OpenAI')
      expect(createdAccount.status).toBe(201)
      const withAccount = (await createdAccount.json()) as ConnectionBody
      expect(withAccount.accounts).toHaveLength(1)
      expect(withAccount.accounts[0]?.displayName).toBe('Shared OpenAI')

      const keyId = withAccount.keys[0]!.id
      const assigned = await iroha.fetch(`${BASE}/${created.id}/keys/${keyId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: withAccount.accounts[0]?.id }),
        csrf,
      })

      expect(assigned.status).toBe(200)
      const grouped = (await assigned.json()) as ConnectionBody
      expect(grouped.keys[0]?.accountId).toBe(withAccount.accounts[0]?.id)
      expect(await (await iroha.database.providers.getKey(keyId))?.accountId).toBe(
        withAccount.accounts[0]?.id,
      )
    })

    test('keys stay ungrouped by default until an account is assigned', async () => {
      const created = await createConnection()
      await addKey(created.id)

      const current = await view(created.id)
      expect(current.accounts).toEqual([])
      for (const key of current.keys) expect(key.accountId).toBeNull()
    })

    test('deleting an account ungroups its keys instead of deleting them', async () => {
      const created = await createConnection()
      await addKey(created.id)
      const current = await view(created.id)
      const account = (await (await createAccount(created.id, 'Shared')).json()) as ConnectionBody
      const accountId = account.accounts[0]!.id

      for (const key of current.keys) {
        await iroha.fetch(`${BASE}/${created.id}/keys/${key.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ accountId }),
          csrf,
        })
      }

      const deleted = await iroha.fetch(`${BASE}/${created.id}/accounts/${accountId}`, {
        method: 'DELETE',
        csrf,
      })

      expect(deleted.status).toBe(200)
      const after = (await deleted.json()) as ConnectionBody
      expect(after.accounts).toEqual([])
      expect(after.keys).toHaveLength(2)
      for (const key of after.keys) expect(key.accountId).toBeNull()
    })

    test('renames an account without disturbing assigned keys', async () => {
      const created = await createConnection()
      const withAccount = (await (await createAccount(created.id, 'Before')).json()) as ConnectionBody
      const accountId = withAccount.accounts[0]!.id
      await iroha.fetch(`${BASE}/${created.id}/keys/${withAccount.keys[0]!.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId }),
        csrf,
      })

      const renamed = await iroha.fetch(`${BASE}/${created.id}/accounts/${accountId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'After' }),
        csrf,
      })

      const after = (await renamed.json()) as ConnectionBody
      expect(after.accounts[0]?.displayName).toBe('After')
      expect(after.keys[0]?.accountId).toBe(accountId)
    })

    test('rejects an account id that the connection does not own', async () => {
      const created = await createConnection()
      const response = await iroha.fetch(`${BASE}/${created.id}/keys/${created.keys[0]!.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: 'ua_absent' }),
        csrf,
      })

      expect(response.status).toBe(400)
      const body = (await response.json()) as { error?: { problems?: { field: string }[] } }
      expect(body.error?.problems?.[0]?.field).toBe('accountId')
    })

    test('rejects an account owned by another connection', async () => {
      const first = await createConnection()
      const secondResponse = await iroha.fetch(BASE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: 'Second',
          baseUrl: BASE_URL,
          upstreamKey: UPSTREAM_KEY,
        }),
        csrf,
      })
      const second = (await secondResponse.json()) as ConnectionBody
      const otherAccount = (await (await createAccount(second.id, 'Other')).json()) as ConnectionBody
      const otherAccountId = otherAccount.accounts[0]!.id

      const response = await iroha.fetch(`${BASE}/${first.id}/keys/${first.keys[0]!.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: otherAccountId }),
        csrf,
      })

      expect(response.status).toBe(400)
      const body = (await response.json()) as { error?: { problems?: { field: string }[] } }
      expect(body.error?.problems?.[0]?.field).toBe('accountId')
    })

    test('deleting an account on an archived connection is refused', async () => {
      const created = await createConnection()
      const withAccount = (await (await createAccount(created.id, 'Shared')).json()) as ConnectionBody
      await iroha.fetch(`${BASE}/${created.id}/archive`, { method: 'POST', csrf })

      const response = await iroha.fetch(
        `${BASE}/${created.id}/accounts/${withAccount.accounts[0]!.id}`,
        { method: 'DELETE', csrf },
      )

      expect(response.status).toBe(409)
      expect(await errorCode(response)).toBe('connection_archived')
    })

    test('audits account lifecycle without secret values', async () => {
      const created = await createConnection()
      const withAccount = (await (await createAccount(created.id, 'Shared')).json()) as ConnectionBody
      const accountId = withAccount.accounts[0]!.id
      await iroha.fetch(`${BASE}/${created.id}/accounts/${accountId}`, { method: 'DELETE', csrf })

      const actions = (await iroha.database.audit.list()).map((event) => event.action)
      expect(actions).toContain('account.created')
      expect(actions).toContain('account.removed')
      for (const event of await iroha.database.audit.list()) {
        expect(JSON.stringify(event.detail ?? null)).not.toContain(UPSTREAM_KEY)
      }
    })
  })
})