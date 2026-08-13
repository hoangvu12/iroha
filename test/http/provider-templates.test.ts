import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { BUILT_IN_PROVIDER_TEMPLATES } from '../../src/providers/templates.ts'
import {
  completeSetup,
  createTestApp,
  errorCode,
  type TestApp,
} from '../support/app.ts'

const BASE = '/api/v1/admin/provider-templates'

interface TemplateDto {
  id: string
  displayName: string
  description: string
  baseUrl: string
  authHeader: string
  authPrefix: string
  capabilities: {
    chat: boolean
    streaming: boolean
    tools: boolean
    structuredOutput: boolean
    responses: boolean
  }
  knownModels: string[]
  inferenceAdapterId: string
  usageAdapterId: string | null
}

interface TemplateListBody {
  templates: TemplateDto[]
}

describe('the Provider Templates admin endpoint', () => {
  let iroha: TestApp
  let csrf: string

  beforeEach(async () => {
    iroha = await createTestApp()
    csrf = (await completeSetup(iroha)).csrf
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  test('lists every built-in template in declaration order', async () => {
    const response = await iroha.fetch(BASE)
    expect(response.status).toBe(200)
    const body = (await response.json()) as TemplateListBody
    expect(body.templates.map((template) => template.id)).toEqual(
      BUILT_IN_PROVIDER_TEMPLATES.map((template) => template.id),
    )
  })

  test('every template carries the safe default fields and no secret material', async () => {
    const response = await iroha.fetch(BASE)
    const body = (await response.json()) as TemplateListBody
    for (const template of body.templates) {
      expect(template.displayName.length).toBeGreaterThan(0)
      expect(template.description.length).toBeGreaterThan(0)
      expect(template.baseUrl).toMatch(/^https:\/\//)
      expect(template.baseUrl).not.toMatch(/sk-|key=|api[-_]?key=/i)
      expect(template.authPrefix === 'Bearer ' || template.authPrefix === '').toBe(true)
      expect(template.inferenceAdapterId).not.toBe('')
    }
  })

  test('built-in templates point at the generic and reactive-only adapters', async () => {
    const response = await iroha.fetch(BASE)
    const body = (await response.json()) as TemplateListBody
    for (const template of body.templates) {
      expect(template.inferenceAdapterId).toBe('generic-inference-adapter')
      expect(template.usageAdapterId).toBe('reactive-only-usage-adapter')
    }
  })

  test('OpenAI template exposes the curated known model list', async () => {
    const response = await iroha.fetch(BASE)
    const body = (await response.json()) as TemplateListBody
    const openai = body.templates.find((template) => template.id === 'openai')
    expect(openai?.knownModels).toContain('gpt-4o-mini')
  })

  test('requires the Owner session', async () => {
    const unclaimed = await createTestApp()
    try {
      const response = await unclaimed.fetch(BASE)
      expect(response.status).toBe(401)
      expect(await errorCode(response)).toBe('authentication_required')
    } finally {
      await unclaimed.dispose()
    }
  })

  test('rejects a cross-origin request', async () => {
    const response = await iroha.fetch(BASE, { headers: { origin: 'https://evil.example' } })
    expect(response.status).toBe(403)
    expect(await errorCode(response)).toBe('cross_origin_denied')
  })
})

describe('creating a Provider Connection from a template', () => {
  let iroha: TestApp
  let csrf: string

  beforeEach(async () => {
    iroha = await createTestApp()
    csrf = (await completeSetup(iroha)).csrf
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  test('creating without templateId stores null and uses the unknown-off defaults', async () => {
    const response = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Hand-configured',
        baseUrl: 'https://api.example.com/v1',
        upstreamKey: 'sk-test-hand-key',
      }),
      csrf,
    })

    expect(response.status).toBe(201)
    const body = (await response.json()) as { templateId: string | null }
    expect(body.templateId).toBeNull()
  })

  test('creating with a templateId stores the templateId on the connection', async () => {
    const response = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'OpenAI via template',
        baseUrl: 'https://api.openai.com/v1',
        upstreamKey: 'sk-test-template-openai',
        templateId: 'openai',
      }),
      csrf,
    })

    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      id: string
      templateId: string | null
      baseUrl: string
      authHeader: string
      authPrefix: string
    }
    expect(body.templateId).toBe('openai')
    expect(body.baseUrl).toBe('https://api.openai.com/v1')
    expect(body.authHeader).toBe('authorization')
    expect(body.authPrefix).toBe('Bearer ')
  })

  test('an unknown templateId returns validation_failed with a templateId field problem', async () => {
    const response = await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Unknown template',
        baseUrl: 'https://api.example.com/v1',
        upstreamKey: 'sk-test-unknown-template',
        templateId: 'mystery-template',
      }),
      csrf,
    })

    expect(response.status).toBe(400)
    expect(await errorCode(response)).toBe('validation_failed')
  })

  test('the listed Provider in /providers echoes the templateId', async () => {
    await iroha.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Templated',
        baseUrl: 'https://api.openai.com/v1',
        upstreamKey: 'sk-test-list-template',
        templateId: 'openai',
      }),
      csrf,
    })

    const list = await iroha.fetch('/api/v1/admin/providers')
    const body = (await list.json()) as { providers: { templateId: string | null }[] }
    const match = body.providers.find((provider) => provider.templateId === 'openai')
    expect(match).toBeDefined()
  })
})