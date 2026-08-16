import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { completeSetup, createTestApp, type TestApp } from '../support/app.ts'

const GATEWAY_KEYS = '/api/v1/admin/gateway-keys'

interface CreatedGatewayKey {
  readonly id: string
  readonly secret: string
}

describe('revoked Gateway Key deletion', () => {
  let iroha: TestApp
  let csrf: string

  beforeEach(async () => {
    iroha = await createTestApp()
    csrf = (await completeSetup(iroha)).csrf
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  test('deletes a revoked key from management and records only its safe identity', async () => {
    const createResponse = await iroha.fetch(GATEWAY_KEYS, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Retired deployment', scope: [] }),
      csrf,
    })
    expect(createResponse.status).toBe(201)
    const created = (await createResponse.json()) as CreatedGatewayKey

    const revokeResponse = await iroha.fetch(`${GATEWAY_KEYS}/${created.id}/revoke`, {
      method: 'POST',
      csrf,
    })
    expect(revokeResponse.status).toBe(200)

    const deleteResponse = await iroha.fetch(`${GATEWAY_KEYS}/${created.id}`, {
      method: 'DELETE',
      csrf,
    })
    expect(deleteResponse.status).toBe(204)

    const listed = (await (await iroha.fetch(GATEWAY_KEYS)).json()) as {
      readonly keys: readonly { readonly id: string }[]
    }
    expect(listed.keys.some((key) => key.id === created.id)).toBe(false)

    const auditResponse = await iroha.fetch('/api/v1/admin/audit?actionPrefix=gateway_key.deleted')
    expect(auditResponse.status).toBe(200)
    const auditText = await auditResponse.text()
    expect(auditText).toContain(created.id)
    expect(auditText).toContain('Retired deployment')
    expect(auditText).not.toContain(created.secret)
    expect(auditText).not.toContain(created.secret.split('.')[1]!)
    expect(auditText).not.toContain('secretHash')
  })

  test('refuses active and unknown keys with stable errors and no deletion audit', async () => {
    const createResponse = await iroha.fetch(GATEWAY_KEYS, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Still active', scope: [] }),
      csrf,
    })
    const created = (await createResponse.json()) as CreatedGatewayKey

    const active = await iroha.fetch(`${GATEWAY_KEYS}/${created.id}`, { method: 'DELETE', csrf })
    expect(active.status).toBe(409)
    expect(await active.json()).toEqual({
      error: { code: 'gateway_key_active', message: 'Revoke this Gateway Key before deleting it.' },
    })

    const unknown = await iroha.fetch(`${GATEWAY_KEYS}/gk_absent`, { method: 'DELETE', csrf })
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toEqual({
      error: { code: 'gateway_key_not_found', message: 'No such Gateway Key.' },
    })

    expect((await iroha.database.gatewayKeys.get(created.id))?.secretHash).toBeTruthy()
    expect((await iroha.database.audit.list()).some((event) => event.action === 'gateway_key.deleted')).toBe(false)
  })

  test('requires owner CSRF protection and cannot restore or delete a deleted key twice', async () => {
    const createResponse = await iroha.fetch(GATEWAY_KEYS, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'One way only', scope: [] }),
      csrf,
    })
    const created = (await createResponse.json()) as CreatedGatewayKey
    await iroha.fetch(`${GATEWAY_KEYS}/${created.id}/revoke`, { method: 'POST', csrf })

    const unprotected = await iroha.fetch(`${GATEWAY_KEYS}/${created.id}`, { method: 'DELETE' })
    expect(unprotected.status).toBe(403)

    expect((await iroha.fetch(`${GATEWAY_KEYS}/${created.id}`, { method: 'DELETE', csrf })).status).toBe(204)
    const second = await iroha.fetch(`${GATEWAY_KEYS}/${created.id}`, { method: 'DELETE', csrf })
    expect(second.status).toBe(404)
    expect(await iroha.database.gatewayKeys.get(created.id)).toBeNull()
  })
})
