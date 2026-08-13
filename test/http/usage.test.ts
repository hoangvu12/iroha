import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  completeSetup,
  createTestApp,
  type TestApp,
} from '../support/app.ts'
import {
  createMockCreditUsageAdapter,
  createMockPlanUsageAdapter,
  type UsageAdapter,
} from '../../src/usage/index.ts'

const UPSTREAM_KEY = 'sk-upstream-secret-value-for-tests'
const BASE_URL = 'https://api.example.com/v1'

interface ConnectionBody {
  id: string
  keys: { id: string; health: string }[]
}

interface UsageBody {
  visibility: 'reactive_only' | 'authoritative'
  reading:
    | {
        unit: string
        balance: number | null
        used: number | null
        limit: number | null
        resetAt: string | null
        scope: { kind: string; [key: string]: unknown }
        confidence: 'confirmed' | 'unknown'
        diagnostics: Record<string, unknown>
      }
    | null
  syncedAt: string | null
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastFailureCode: string | null
  lastFailureMessage: string | null
  stale: boolean
  nextPollAllowedAt: string | null
  recovery:
    | null
    | {
        authoritative: boolean
        hasCapacity: boolean
        scope: { kind: string; [key: string]: unknown }
        takenAt: string
      }
}

describe('the Owner usage surface', () => {
  let iroha: TestApp
  let csrf: string
  let connection: ConnectionBody

  beforeEach(async () => {
    iroha = await createTestApp()
    csrf = (await completeSetup(iroha)).csrf
    const created = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Usage example',
        baseUrl: BASE_URL,
        upstreamKey: UPSTREAM_KEY,
      }),
      csrf,
    })
    if (created.status !== 201) {
      throw new Error(`Connection create failed with ${created.status}: ${await created.text()}`)
    }
    connection = (await created.json()) as ConnectionBody
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  const viewUsage = () =>
    iroha.fetch(`/api/v1/admin/providers/${connection.id}/usage`)

  const refreshUsage = () =>
    iroha.fetch(`/api/v1/admin/providers/${connection.id}/usage/refresh`, {
      method: 'POST',
      csrf,
    })

  test('the default reactive-only adapter reports Unknown until first refresh', async () => {
    const initial = (await (await viewUsage()).json()) as UsageBody
    expect(initial.visibility).toBe('reactive_only')
    expect(initial.reading).toBeNull()
    expect(initial.stale).toBe(false)

    const refreshed = (await (await refreshUsage()).json()) as UsageBody
    expect(refreshed.visibility).toBe('reactive_only')
    expect(refreshed.reading).not.toBeNull()
    expect(refreshed.reading?.balance).toBeNull()
    expect(refreshed.reading?.confidence).toBe('unknown')
    expect(refreshed.reading?.scope.kind).toBe('unknown')
    expect(refreshed.lastSuccessAt).not.toBeNull()
    expect(refreshed.stale).toBe(false)
    expect(refreshed.recovery).toBeNull()
  })

  test('an authoritative credit reading exposes units, scope, and freshness through HTTP', async () => {
    const adapter = createMockCreditUsageAdapter({
      initialBalances: { [UPSTREAM_KEY]: 42 },
      accountId: 'mock-account-id',
    })
    await iroha.dispose()
    iroha = await createTestApp({ usageAdapter: adapter })
    csrf = (await completeSetup(iroha)).csrf
    const created = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Usage example',
        baseUrl: BASE_URL,
        upstreamKey: UPSTREAM_KEY,
      }),
      csrf,
    })
    connection = (await created.json()) as ConnectionBody

    const response = await iroha.fetch(
      `/api/v1/admin/providers/${connection.id}/usage/refresh`,
      { method: 'POST', csrf },
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as UsageBody
    expect(body.visibility).toBe('authoritative')
    expect(body.reading).not.toBeNull()
    expect(body.reading?.unit).toBe('usd')
    expect(body.reading?.balance).toBe(42)
    expect(body.reading?.confidence).toBe('confirmed')
    expect(body.reading?.scope).toEqual({ kind: 'account', accountId: 'mock-account-id' })
    expect(body.stale).toBe(false)
  })

  test('a failing refresh retains the previous reading and marks the view stale', async () => {
    const adapter = createMockCreditUsageAdapter({
      initialBalances: { [UPSTREAM_KEY]: 42 },
      accountId: 'mock-account-id',
    })
    await iroha.dispose()
    iroha = await createTestApp({ usageAdapter: adapter })
    csrf = (await completeSetup(iroha)).csrf
    const created = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Usage example',
        baseUrl: BASE_URL,
        upstreamKey: UPSTREAM_KEY,
      }),
      csrf,
    })
    connection = (await created.json()) as ConnectionBody

    const firstRefresh = await iroha.fetch(
      `/api/v1/admin/providers/${connection.id}/usage/refresh`,
      { method: 'POST', csrf },
    )
    expect(firstRefresh.status).toBe(200)

    iroha.clock.advance(2)
    adapter.respondWith({
      ok: false,
      failure: { code: 'upstream_refused', status: 503, message: 'service unavailable' },
    })

    const second = await iroha.fetch(
      `/api/v1/admin/providers/${connection.id}/usage/refresh`,
      { method: 'POST', csrf },
    )
    expect(second.status).toBe(200)
    const body = (await second.json()) as UsageBody
    expect(body.stale).toBe(true)
    expect(body.lastFailureCode).toBe('upstream_refused')
    expect(body.lastFailureMessage).toContain('HTTP 503')
    expect(body.reading).not.toBeNull()
    expect(body.reading?.balance).toBe(42)
  })

  test('a confirmed zero is reported as zero, distinct from an Unknown reading', async () => {
    const adapter = createMockCreditUsageAdapter({
      initialBalances: { [UPSTREAM_KEY]: 0 },
      accountId: 'mock-account-id',
    })
    await iroha.dispose()
    iroha = await createTestApp({ usageAdapter: adapter })
    csrf = (await completeSetup(iroha)).csrf
    const created = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Usage example',
        baseUrl: BASE_URL,
        upstreamKey: UPSTREAM_KEY,
      }),
      csrf,
    })
    connection = (await created.json()) as ConnectionBody

    const response = await iroha.fetch(
      `/api/v1/admin/providers/${connection.id}/usage/refresh`,
      { method: 'POST', csrf },
    )
    const body = (await response.json()) as UsageBody
    expect(body.reading?.balance).toBe(0)
    expect(body.reading?.confidence).toBe('confirmed')
  })

  test('a plan-window reading exposes used, limit, and reset time', async () => {
    const resetAt = new Date('2026-01-15T00:00:00.000Z')
    const adapter = createMockPlanUsageAdapter({
      used: 30,
      limit: 100,
      resetAt,
      scope: 'connection_model',
      model: 'gpt-4o',
    })
    await iroha.dispose()
    iroha = await createTestApp({ usageAdapter: adapter })
    csrf = (await completeSetup(iroha)).csrf
    const created = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Usage example',
        baseUrl: BASE_URL,
        upstreamKey: UPSTREAM_KEY,
      }),
      csrf,
    })
    connection = (await created.json()) as ConnectionBody

    const response = await iroha.fetch(
      `/api/v1/admin/providers/${connection.id}/usage/refresh`,
      { method: 'POST', csrf },
    )
    const body = (await response.json()) as UsageBody
    expect(body.reading?.unit).toBe('requests')
    expect(body.reading?.used).toBe(30)
    expect(body.reading?.limit).toBe(100)
    expect(body.reading?.balance).toBe(70)
    expect(body.reading?.resetAt).toBe(resetAt.toISOString())
    expect(body.reading?.scope).toEqual({ kind: 'connection_model', model: 'gpt-4o' })
  })

  test('authoritative recovery evidence appears in the view when capacity is available', async () => {
    const adapter = createMockCreditUsageAdapter({
      initialBalances: { [UPSTREAM_KEY]: 25 },
      accountId: 'mock-account-id',
    })
    await iroha.dispose()
    iroha = await createTestApp({ usageAdapter: adapter })
    csrf = (await completeSetup(iroha)).csrf
    const created = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Usage example',
        baseUrl: BASE_URL,
        upstreamKey: UPSTREAM_KEY,
      }),
      csrf,
    })
    connection = (await created.json()) as ConnectionBody

    const refreshed = await iroha.fetch(
      `/api/v1/admin/providers/${connection.id}/usage/refresh`,
      { method: 'POST', csrf },
    )
    const body = (await refreshed.json()) as UsageBody
    expect(body.recovery).not.toBeNull()
    expect(body.recovery?.authoritative).toBe(true)
    expect(body.recovery?.hasCapacity).toBe(true)
    expect(body.recovery?.scope).toEqual({ kind: 'account', accountId: 'mock-account-id' })
  })

  test('refuses an unauthenticated Owner', async () => {
    await iroha.dispose()
    iroha = await createTestApp()
    const view = await iroha.fetch(
      `/api/v1/admin/providers/pr_does_not_exist/usage`,
    )
    expect(view.status).toBe(401)

    const refresh = await iroha.fetch(
      `/api/v1/admin/providers/pr_does_not_exist/usage/refresh`,
      { method: 'POST' },
    )
    expect(refresh.status).toBe(401)
  })

  test('reports an unknown Provider as provider_not_found', async () => {
    const view = await iroha.fetch('/api/v1/admin/providers/pr_unknown/usage')
    expect(view.status).toBe(404)
    const body = (await view.json()) as { error: { code: string } }
    expect(body.error.code).toBe('provider_not_found')
  })

  test('reports an archived connection as provider_archived', async () => {
    await iroha.fetch(`/api/v1/admin/providers/${connection.id}/archive`, {
      method: 'POST',
      csrf,
    })
    const view = await iroha.fetch(
      `/api/v1/admin/providers/${connection.id}/usage/refresh`,
      { method: 'POST', csrf },
    )
    expect(view.status).toBe(409)
    const body = (await view.json()) as { error: { code: string } }
    expect(body.error.code).toBe('provider_archived')
  })

  test('a reactive-only adapter never produces recovery evidence', async () => {
    await iroha.fetch(
      `/api/v1/admin/providers/${connection.id}/usage/refresh`,
      { method: 'POST', csrf },
    )
    const view = await iroha.fetch(
      `/api/v1/admin/providers/${connection.id}/usage`,
    )
    const body = (await view.json()) as UsageBody
    expect(body.visibility).toBe('reactive_only')
    expect(body.recovery).toBeNull()
  })
})

describe('Usage Adapter mock fixtures exercised end-to-end', () => {
  let iroha: TestApp

  afterEach(async () => {
    if (iroha !== undefined) await iroha.dispose()
  })

  const assemble = async (adapter: UsageAdapter) => {
    iroha = await createTestApp({ usageAdapter: adapter })
    const csrf = (await completeSetup(iroha)).csrf
    const created = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'End-to-end usage',
        baseUrl: BASE_URL,
        upstreamKey: UPSTREAM_KEY,
      }),
      csrf,
    })
    if (created.status !== 201) {
      throw new Error(`Connection create failed: ${await created.text()}`)
    }
    return {
      csrf,
      connection: (await created.json()) as ConnectionBody,
    }
  }

  test('a credit adapter with multiple keys reports a per-account balance', async () => {
    const adapter = createMockCreditUsageAdapter({
      initialBalances: { [UPSTREAM_KEY]: 12 },
      accountId: 'account-from-mock',
    })
    const { csrf, connection } = await assemble(adapter)

    const response = await iroha.fetch(
      `/api/v1/admin/providers/${connection.id}/usage/refresh`,
      { method: 'POST', csrf },
    )
    const body = (await response.json()) as UsageBody
    expect(body.reading?.balance).toBe(12)
    expect(body.reading?.scope).toEqual({ kind: 'account', accountId: 'account-from-mock' })
  })

  test('a plan adapter reports windowed usage with a reset time and connection_model scope', async () => {
    const resetAt = new Date('2026-02-01T00:00:00.000Z')
    const adapter = createMockPlanUsageAdapter({
      used: 80,
      limit: 100,
      resetAt,
      scope: 'connection_model',
      model: 'claude-sonnet',
    })
    const { csrf, connection } = await assemble(adapter)

    const response = await iroha.fetch(
      `/api/v1/admin/providers/${connection.id}/usage/refresh`,
      { method: 'POST', csrf },
    )
    const body = (await response.json()) as UsageBody
    expect(body.reading?.used).toBe(80)
    expect(body.reading?.limit).toBe(100)
    expect(body.reading?.balance).toBe(20)
    expect(body.reading?.resetAt).toBe(resetAt.toISOString())
    expect(body.reading?.scope).toEqual({ kind: 'connection_model', model: 'claude-sonnet' })
  })

  test('a rate-limited adapter returns 429 with a structural code and keeps the prior reading', async () => {
    const adapter = createMockCreditUsageAdapter({
      initialBalances: { [UPSTREAM_KEY]: 88 },
      accountId: 'mock-account-id',
    })
    const { csrf, connection } = await assemble(adapter)

    const firstRefresh = await iroha.fetch(
      `/api/v1/admin/providers/${connection.id}/usage/refresh`,
      { method: 'POST', csrf },
    )
    expect(firstRefresh.status).toBe(200)

    iroha.clock.advance(2)
    adapter.respondWith({
      ok: false,
      failure: { code: 'rate_limited', retryAfterSeconds: 30 },
    })

    const secondRefresh = await iroha.fetch(
      `/api/v1/admin/providers/${connection.id}/usage/refresh`,
      { method: 'POST', csrf },
    )
    expect(secondRefresh.status).toBe(429)
    const errorBody = (await secondRefresh.json()) as { error: { code: string } }
    expect(errorBody.error.code).toBe('rate_limited')

    const view = await iroha.fetch(
      `/api/v1/admin/providers/${connection.id}/usage`,
    )
    const body = (await view.json()) as UsageBody
    expect(body.stale).toBe(true)
    expect(body.reading?.balance).toBe(88)
    expect(body.lastFailureCode).toBe('rate_limited')
  })
})
