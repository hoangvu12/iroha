import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import OpenAI from 'openai'
import { authorizeQualifiedModel, parseQualifiedModelId } from '../../src/http/qualified-model.ts'
import { appFetch, completeSetup, createTestApp, type TestApp } from '../support/app.ts'

describe('global Qualified Model discovery', () => {
  let iroha: TestApp
  let csrf: string

  beforeEach(async () => {
    iroha = await createTestApp()
    csrf = (await completeSetup(iroha)).csrf
  })

  afterEach(async () => await iroha.dispose())

  test('the official OpenAI client lists sorted, deduplicated Qualified Model IDs for selected access', async () => {
    const alpha = await createProvider('Alpha')
    const beta = await createProvider('Beta')
    await addModel(alpha, 'openai/gpt-4o')
    await addModel(alpha, 'zeta')
    await addModel(beta, 'claude-3')
    const secret = await createKey({ mode: 'selected', providers: [
      { providerId: beta, models: null },
      { providerId: alpha, models: ['zeta', 'openai/gpt-4o', 'openai/gpt-4o'] },
    ] })

    const client = new OpenAI({ apiKey: secret, baseURL: 'http://iroha.test/v1', fetch: appFetch(iroha.app), maxRetries: 0 })
    const ids: string[] = []
    for await (const model of await client.models.list()) ids.push(model.id)
    expect(ids).toEqual(['alpha/openai/gpt-4o', 'alpha/zeta', 'beta/claude-3'].sort())

    const providerScoped = await iroha.fetch('/providers/alpha/v1/models', { headers: { authorization: `Bearer ${secret}` } })
    expect(((await providerScoped.json()) as { data: { id: string }[] }).data.map((model) => model.id).sort()).toEqual(['openai/gpt-4o', 'zeta'])
  })

  test('unrestricted discovery follows active catalog changes without exposing disabled Providers', async () => {
    const alpha = await createProvider('Alpha')
    await addModel(alpha, 'nested/model')
    const secret = await createKey({ mode: 'all' })
    expect(await listIds(secret)).toEqual(['alpha/nested/model'])

    await iroha.fetch(`/api/v1/admin/providers/${alpha}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }), csrf,
    })
    expect(await listIds(secret)).toEqual([])
  })

  test('parses nested model IDs and normalizes malformed IDs and Provider privacy failures', async () => {
    expect(parseQualifiedModelId('example/openai/gpt-4o')).toEqual({ ok: true, providerHandle: 'example', modelId: 'openai/gpt-4o' })
    for (const malformed of ['gpt-4o', '/gpt-4o', 'pr_example/']) {
      expect(parseQualifiedModelId(malformed)).toEqual({ ok: false, code: 'invalid_model_id' })
    }
    expect(parseQualifiedModelId('INVALID/model')).toEqual({ ok: false, code: 'invalid_model_id' })

    const providerId = await createProvider('Private')
    const selected = await createKey({ mode: 'selected', providers: [{ providerId, models: ['known', 'unknown/nested'] }] })
    expect(await authorizeQualifiedModel({ input: 'private/unknown/nested', token: selected, gatewayKeys: iroha.gatewayKeys, database: iroha.database, providers: iroha.providers })).toMatchObject({ ok: true, providerId, providerHandle: 'private', modelId: 'unknown/nested' })
    expect(await authorizeQualifiedModel({ input: 'private/denied', token: selected, gatewayKeys: iroha.gatewayKeys, database: iroha.database, providers: iroha.providers })).toEqual({ ok: false, code: 'model_not_allowed' })
    expect(await authorizeQualifiedModel({ input: 'absent/known', token: selected, gatewayKeys: iroha.gatewayKeys, database: iroha.database, providers: iroha.providers })).toEqual({ ok: false, code: 'provider_not_allowed' })
    const inaccessible = await createProvider('Inaccessible')
    expect(await authorizeQualifiedModel({ input: 'inaccessible/known', token: selected, gatewayKeys: iroha.gatewayKeys, database: iroha.database, providers: iroha.providers })).toEqual({ ok: false, code: 'provider_not_allowed' })

    await iroha.fetch(`/api/v1/admin/providers/${providerId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }), csrf,
    })
    expect(await authorizeQualifiedModel({ input: 'private/known', token: selected, gatewayKeys: iroha.gatewayKeys, database: iroha.database, providers: iroha.providers })).toEqual({ ok: false, code: 'provider_not_allowed' })
    await iroha.fetch(`/api/v1/admin/providers/${providerId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }), csrf,
    })
    await iroha.fetch(`/api/v1/admin/providers/${providerId}/archive`, { method: 'POST', csrf })
    expect(await authorizeQualifiedModel({ input: 'private/known', token: selected, gatewayKeys: iroha.gatewayKeys, database: iroha.database, providers: iroha.providers })).toEqual({ ok: false, code: 'provider_not_allowed' })
  })

  test('rejects invalid Gateway Keys without catalog or upstream traffic', async () => {
    const response = await iroha.fetch('/v1/models', { headers: { authorization: 'Bearer gk_absent.wrong' } })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: { code: 'gateway_key_invalid', message: 'This Gateway Key is not valid.' } })
  })

  async function createProvider(displayName: string): Promise<string> {
    const response = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName, handle: displayName.toLowerCase(), baseUrl: 'https://api.example.com/v1', keys: [{ upstreamKey: `sk-${displayName}` }] }), csrf,
    })
    return ((await response.json()) as { id: string }).id
  }

  async function addModel(providerId: string, modelId: string): Promise<void> {
    const response = await iroha.fetch(`/api/v1/admin/providers/${providerId}/catalog/models`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelId }), csrf,
    })
    expect(response.status).toBe(200)
  }

  async function createKey(access: unknown): Promise<string> {
    const response = await iroha.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Global client', access }), csrf,
    })
    return ((await response.json()) as { secret: string }).secret
  }

  async function listIds(secret: string): Promise<string[]> {
    const response = await iroha.fetch('/v1/models', { headers: { authorization: `Bearer ${secret}` } })
    const body = (await response.json()) as { data: { id: string }[] }
    return body.data.map((model) => model.id)
  }
})
