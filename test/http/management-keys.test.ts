import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { completeSetup, createTestApp, errorCode, ORIGIN, type TestApp } from '../support/app.ts'

describe('Management Keys', () => {
  let iroha: TestApp
  let csrf: string

  beforeEach(async () => {
    iroha = await createTestApp()
    csrf = (await completeSetup(iroha)).csrf
  })
  afterEach(async () => { await iroha.dispose() })

  async function create(scopes?: string[]) {
    const response = await iroha.fetch('/api/v1/admin/management-keys/', {
      method: 'POST', csrf, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'automation', ...(scopes ? { scopes } : {}) }),
    })
    expect(response.status).toBe(201)
    return await response.json() as { id: string; secret: string }
  }

  const machineFetch = (path: string, secret: string, init: RequestInit = {}) => iroha.app.handle(new Request(`${ORIGIN}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${secret}`, ...((init.headers as Record<string, string>) ?? {}) },
  }))

  test('uses a bearer key on the existing admin routes without a cookie or CSRF token', async () => {
    const key = await create()
    expect((await machineFetch('/api/v1/admin/providers', key.secret)).status).toBe(200)
    const created = await machineFetch('/api/v1/admin/providers', key.secret, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Agent Provider', handle: 'agent-provider', baseUrl: 'https://api.example.com/v1', keys: [{ upstreamKey: 'sk-test' }] }),
    })
    expect(created.status).toBe(201)
  })

  test('enforces read, write, and reveal as separate permissions', async () => {
    const read = await create(['admin:read'])
    expect((await machineFetch('/api/v1/admin/providers', read.secret)).status).toBe(200)
    const denied = await machineFetch('/api/v1/admin/providers', read.secret, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(denied.status).toBe(401)
    expect(await errorCode(denied)).toBe('authentication_required')
  })

  test('revocation immediately stops authentication and deletion requires revocation', async () => {
    const key = await create()
    expect((await iroha.fetch(`/api/v1/admin/management-keys/${key.id}`, { method: 'DELETE', csrf })).status).toBe(409)
    expect((await iroha.fetch(`/api/v1/admin/management-keys/${key.id}/revoke`, { method: 'POST', csrf })).status).toBe(200)
    expect((await machineFetch('/api/v1/admin/providers', key.secret)).status).toBe(401)
    expect((await iroha.fetch(`/api/v1/admin/management-keys/${key.id}`, { method: 'DELETE', csrf })).status).toBe(204)
  })

  test('does not let a Management Key create more Management Keys', async () => {
    const key = await create()
    const response = await machineFetch('/api/v1/admin/management-keys/', key.secret, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'child' }) })
    expect(response.status).toBe(401)
  })
})
