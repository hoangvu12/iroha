import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  ORIGIN,
  appFetch,
  completeSetup,
  createTestApp,
  errorCode,
  fakeKeyProbe,
  type FakeKeyProbe,
  type TestApp,
} from '../support/app.ts'

const BASE_URL = 'https://api.example.com/v1'
const BASE = '/api/v1/admin/providers'

interface KeyBody {
  id: string
  baseUrl: string | null
  effectiveBaseUrl: string
  health:
    | 'unverified'
    | 'active'
    | 'cooling_down'
    | 'invalid_authentication'
    | 'exhausted'
    | 'disabled'
  lastProbe: { at: string; verdict: string; reason: string | null } | null
  healthReason: string | null
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
  baseUrl: string
  keys: KeyBody[]
  accounts: AccountBody[]
}

interface BulkAddResponse {
  added: { index: number; keyId: string }[]
  failed: { index: number; problems: { field: string; message: string }[] }[]
}

interface ErrorBody {
  error: {
    code: string
    message?: string
    problems?: { field: string; message: string }[]
  }
}

interface AuditFeedBody {
  events: { id: number; occurredAt: string; action: string; outcome: string; detail: unknown }[]
  total: number
}

describe('POST /providers/:id/keys/bulk', () => {
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
      body: JSON.stringify({
        displayName: 'Example',
        baseUrl: BASE_URL,
        keys: [{ upstreamKey: 'sk-initial-upstream-key' }],
      }),
      csrf,
    })
    if (response.status !== 201) {
      throw new Error(`Create failed with ${response.status}: ${await response.text()}`)
    }
    return (await response.json()) as ConnectionBody
  }

  const view = async (providerId: string): Promise<ConnectionBody> =>
    (await (await iroha.fetch(`${BASE}/${providerId}`)).json()) as ConnectionBody

  const bulkAdd = async (
    providerId: string,
    body: unknown,
    options: { noCsrf?: boolean; noAuth?: boolean } = {},
  ): Promise<Response> => {
    if (options.noAuth) {
      return await appFetch(iroha.app)(`${ORIGIN}${BASE}/${providerId}/keys/bulk`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    }
    return await iroha.fetch(`${BASE}/${providerId}/keys/bulk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(options.noCsrf ? {} : { csrf }),
    })
  }

  test('rejects an empty list with a 400 validation_failed', async () => {
    const created = await createConnection()

    const response = await bulkAdd(created.id, { keys: [] })

    expect(response.status).toBe(400)
    const failure = (await response.json()) as ErrorBody
    expect(failure.error.code).toBe('validation_failed')
    expect(failure.error.problems?.[0]?.field).toBe('keys')
    expect((await view(created.id)).keys).toHaveLength(1)
  })

  test('rejects a batch over 200 entries with a 400 validation_failed', async () => {
    const created = await createConnection()
    const keys = Array.from({ length: 201 }, (_, index) => ({
      upstreamKey: `sk-oversized-${index}`,
    }))

    const response = await bulkAdd(created.id, { keys })

    expect(response.status).toBe(400)
    const failure = (await response.json()) as ErrorBody
    expect(failure.error.code).toBe('validation_failed')
    expect(failure.error.problems?.[0]?.field).toBe('keys')
    expect((await view(created.id)).keys).toHaveLength(1)
  })

  test('rejects a body without a keys field with a 400 validation_failed', async () => {
    const created = await createConnection()

    const response = await bulkAdd(created.id, {})

    expect(response.status).toBe(400)
    const failure = (await response.json()) as ErrorBody
    expect(failure.error.code).toBe('validation_failed')
    expect(failure.error.problems?.[0]?.field).toBe('keys')
    expect((await view(created.id)).keys).toHaveLength(1)
  })

  test('rejects a malformed upstreamKey with a 400 validation_failed', async () => {
    const created = await createConnection()

    const response = await bulkAdd(created.id, { keys: [{ upstreamKey: 123 }] })

    expect(response.status).toBe(400)
    const failure = (await response.json()) as ErrorBody
    expect(failure.error.code).toBe('validation_failed')
    expect(failure.error.problems?.[0]?.field).toBe('keys[0].upstreamKey')
    expect((await view(created.id)).keys).toHaveLength(1)
  })

  test('records a bad baseUrl in the entry’s failed[] verdict with a baseUrl problem', async () => {
    // The route only validates shape (object with `keys`, entries are objects
    // with the right field types), so a bad URL passes whole-batch validation
    // and is caught by the registry’s per-entry validator — it surfaces as a
    // 200 with the entry in `failed[]`, not a whole-batch 400. The Owner UI
    // feeds the failure back into the partial-success alert in the bulk
    // dialog. (Ticket 08 listed this as a whole-batch 400; the spec and the
    // implementation keep it per-entry.)
    const created = await createConnection()

    const response = await bulkAdd(created.id, {
      keys: [{ upstreamKey: 'sk-a', baseUrl: 'not-a-url' }],
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as BulkAddResponse
    expect(body.added).toEqual([])
    expect(body.failed).toHaveLength(1)
    expect(body.failed[0]?.index).toBe(0)
    expect(body.failed[0]?.problems?.[0]?.field).toBe('baseUrl')
    expect((await view(created.id)).keys).toHaveLength(1)
  })

  test('adds an all-valid batch and round-trips both keys through GET /providers/:id', async () => {
    const created = await createConnection()

    const response = await bulkAdd(created.id, {
      keys: [
        { upstreamKey: 'sk-a' },
        { upstreamKey: 'sk-b', baseUrl: 'https://example.com/v1' },
      ],
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as BulkAddResponse
    expect(body.failed).toEqual([])
    expect(body.added).toHaveLength(2)
    expect(body.added[0]?.index).toBe(0)
    expect(body.added[1]?.index).toBe(1)
    expect(body.added[0]?.keyId).toMatch(/^uk_/)
    expect(body.added[1]?.keyId).toMatch(/^uk_/)

    const after = await view(created.id)
    const newKeys = after.keys.filter((key) => body.added.some((entry) => entry.keyId === key.id))
    expect(newKeys).toHaveLength(2)
    // Probe may still be settling; assertion is on presence, not on the final
    // probe result.
    for (const key of newKeys) {
      expect(['unverified', 'active']).toContain(key.health)
    }
  })

  test('keeps the surrounding entries when a blank upstreamKey sits between them', async () => {
    const created = await createConnection()

    const response = await bulkAdd(created.id, {
      keys: [
        { upstreamKey: 'sk-a' },
        { upstreamKey: '' },
        { upstreamKey: 'sk-b' },
      ],
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as BulkAddResponse
    expect(body.added.map((entry) => entry.index)).toEqual([0, 2])
    expect(body.failed).toHaveLength(1)
    expect(body.failed[0]?.index).toBe(1)
    expect(body.failed[0]?.problems?.[0]?.field).toBe('upstreamKey')

    const after = await view(created.id)
    const addedIds = new Set(body.added.map((entry) => entry.keyId))
    const surviving = after.keys.filter((key) => addedIds.has(key.id))
    expect(surviving).toHaveLength(2)
  })

  test('round-trips baseUrl inheritance semantics on the all-valid batch', async () => {
    const created = await createConnection()

    const response = await bulkAdd(created.id, {
      keys: [
        { upstreamKey: 'sk-a' },
        { upstreamKey: 'sk-b', baseUrl: 'https://example.com/v1' },
      ],
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as BulkAddResponse
    const bareKeyId = body.added[0]?.keyId
    const overrideKeyId = body.added[1]?.keyId
    expect(bareKeyId).toBeDefined()
    expect(overrideKeyId).toBeDefined()

    const after = await view(created.id)
    const bareKey = after.keys.find((key) => key.id === bareKeyId)
    const overrideKey = after.keys.find((key) => key.id === overrideKeyId)
    expect(bareKey?.baseUrl).toBeNull()
    expect(bareKey?.effectiveBaseUrl).toBe(created.baseUrl)
    expect(overrideKey?.baseUrl).toBe('https://example.com/v1')
    expect(overrideKey?.effectiveBaseUrl).toBe('https://example.com/v1')
  })

  test('refuses a bulk add on an archived provider with provider_archived', async () => {
    const created = await createConnection()
    await iroha.fetch(`${BASE}/${created.id}/archive`, { method: 'POST', csrf })

    const response = await bulkAdd(created.id, { keys: [{ upstreamKey: 'sk-a' }] })

    expect(response.status).toBe(409)
    expect(await errorCode(response)).toBe('provider_archived')
    expect((await view(created.id)).keys).toHaveLength(1)
  })

  test('returns 404 provider_not_found for an unknown provider id', async () => {
    const response = await bulkAdd('pr_does-not-exist', { keys: [{ upstreamKey: 'sk-a' }] })

    expect(response.status).toBe(404)
    expect(await errorCode(response)).toBe('provider_not_found')
  })

  test('returns 401 authentication_required without an Owner cookie', async () => {
    const created = await createConnection()

    const response = await bulkAdd(created.id, { keys: [{ upstreamKey: 'sk-a' }] }, { noAuth: true })

    expect(response.status).toBe(401)
    expect(await errorCode(response)).toBe('authentication_required')
    expect((await view(created.id)).keys).toHaveLength(1)
  })

  test('returns 403 when the Owner cookie is present but the CSRF header is missing', async () => {
    // Ticket 08 expected 403 `authentication_required`; the guard instead
    // reports 403 `csrf_token_invalid` (matching the existing
    // `POST /providers/:id/keys` behaviour and the shared `requireOwner`
    // contract). Both refuse the request before any work is done.
    const created = await createConnection()

    const response = await bulkAdd(created.id, { keys: [{ upstreamKey: 'sk-a' }] }, { noCsrf: true })

    expect(response.status).toBe(403)
    expect((await view(created.id)).keys).toHaveLength(1)
  })

  test('writes a key.created audit row for every successfully added key, not one per batch', async () => {
    const created = await createConnection()

    const response = await bulkAdd(created.id, {
      keys: [
        { upstreamKey: 'sk-audit-1' },
        { upstreamKey: 'sk-audit-2' },
        { upstreamKey: 'sk-audit-3' },
      ],
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as BulkAddResponse
    expect(body.added).toHaveLength(3)

    const feed = await iroha.fetch('/api/v1/admin/audit?actionPrefix=key.created')
    const feedBody = (await feed.json()) as AuditFeedBody
    const createdRows = feedBody.events.filter((event) => event.action === 'key.created')
    // The connection-creation key plus the three bulk-imported keys.
    expect(createdRows.length).toBeGreaterThanOrEqual(4)

    const addedKeyIds = new Set(body.added.map((entry) => entry.keyId))
    const matchingRows = createdRows.filter((event) => {
      const detail = event.detail as { providerId?: unknown; keyId?: unknown } | null
      return (
        detail !== null &&
        detail.providerId === created.id &&
        typeof detail.keyId === 'string' &&
        addedKeyIds.has(detail.keyId)
      )
    })
    expect(matchingRows).toHaveLength(3)
    for (const row of matchingRows) {
      const detail = row.detail as { providerId?: unknown; keyId?: unknown }
      expect(detail.providerId).toBe(created.id)
      expect(addedKeyIds.has(detail.keyId as string)).toBe(true)
    }
  })
})