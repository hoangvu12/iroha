import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createSecretCipher } from '../../src/crypto/index.ts'
import { createGenericInferenceAdapter } from '../../src/inference/generic-adapter.ts'
import {
  AdapterRegistry,
  createBuiltInAdapterRegistry,
  ProviderRegistry,
} from '../../src/providers/index.ts'
import {
  GENERIC_INFERENCE_ADAPTER_ID,
  REACTIVE_ONLY_USAGE_ADAPTER_ID,
  type ProviderTemplate,
} from '../../src/providers/templates.ts'
import { sqliteEngine } from '../persistence/engines.ts'
import { fakeKeyProbe, TEST_MASTER_KEY } from '../support/app.ts'
import { testClock, type TestClock } from '../support/identity.ts'

const OPENAI_BASE_URL = 'https://api.openai.com/v1'

function safeTemplate(id: string, over: Partial<ProviderTemplate> = {}): ProviderTemplate {
  return {
    id,
    displayName: `Template ${id}`,
    description: `Template ${id} for tests.`,
    baseUrl: OPENAI_BASE_URL,
    authHeader: 'authorization',
    authPrefix: 'Bearer ',
    capabilities: {
      chat: true,
      streaming: true,
      tools: true,
      structuredOutput: true,
      responses: true,
    },
    knownModels: ['curated-model-a', 'curated-model-b'],
    inferenceAdapterId: GENERIC_INFERENCE_ADAPTER_ID,
    usageAdapterId: REACTIVE_ONLY_USAGE_ADAPTER_ID,
    ...over,
  }
}

describe('Provider Connection templates', () => {
  let opened: Awaited<ReturnType<typeof sqliteEngine.open>>
  let clock: TestClock
  let registry: ProviderRegistry
  let adapterRegistry: AdapterRegistry
  let dispose: () => Promise<void>

  beforeEach(async () => {
    opened = await sqliteEngine.open()
    clock = testClock()
    adapterRegistry = createBuiltInAdapterRegistry()
    registry = new ProviderRegistry({
      database: opened.database,
      cipher: createSecretCipher(TEST_MASTER_KEY),
      keyProbe: fakeKeyProbe(),
      adapterRegistry,
      clock,
    })
    dispose = () => opened.dispose()
  })

  afterEach(async () => {
    await dispose()
  })

  test('omitting templateId produces a null templateId and unknown-off capabilities', async () => {
    const created = await registry.create({
      displayName: 'Hand-configured',
      baseUrl: 'https://api.example.com/v1',
      keys: [{ upstreamKey: 'sk-test-hand-key' }],
    })
    if (!created.ok) throw new Error(created.failure.code)

    expect(created.value.templateId).toBeNull()
    expect(created.value.baseUrl).toBe('https://api.example.com/v1')
  })

  test('a known templateId prefills the connection defaults', async () => {
    const created = await registry.create({
      displayName: 'OpenAI connection',
      baseUrl: OPENAI_BASE_URL,
      keys: [{ upstreamKey: 'sk-test-openai-key' }],
      templateId: 'openai',
    })
    if (!created.ok) throw new Error(created.failure.code)

    expect(created.value.templateId).toBe('openai')
    expect(created.value.baseUrl).toBe(OPENAI_BASE_URL)
  })

  test('the Owner may override every field the template prefills', async () => {
    const created = await registry.create({
      displayName: 'OpenAI on a private deployment',
      baseUrl: 'https://proxy.example.internal/openai',
      keys: [{ upstreamKey: 'sk-test-internal-key' }],
      templateId: 'openai',
      authHeader: 'X-Api-Key',
      authPrefix: '',
    })
    if (!created.ok) throw new Error(created.failure.code)

    expect(created.value.templateId).toBe('openai')
    expect(created.value.baseUrl).toBe('https://proxy.example.internal/openai')
    expect(created.value.authHeader).toBe('X-Api-Key')
    expect(created.value.authPrefix).toBe('')
  })

  test('an unknown templateId is a validation failure, never a silent fallback', async () => {
    const result = await registry.create({
      displayName: 'Wrong template',
      baseUrl: OPENAI_BASE_URL,
      keys: [{ upstreamKey: 'sk-test-missing-template' }],
      templateId: 'not-a-real-template',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('validation_failed')
    if (result.failure.code !== 'validation_failed') return
    expect(result.failure.problems.some((p) => p.field === 'templateId')).toBe(true)
  })

  test('a blank templateId is a validation failure', async () => {
    const result = await registry.create({
      displayName: 'Blank template',
      baseUrl: OPENAI_BASE_URL,
      keys: [{ upstreamKey: 'sk-test-blank-template' }],
      templateId: '   ',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('validation_failed')
  })

  test('a non-string templateId is a validation failure', async () => {
    const result = await registry.create({
      displayName: 'Number template',
      baseUrl: OPENAI_BASE_URL,
      keys: [{ upstreamKey: 'sk-test-numeric-template' }],
      templateId: 42,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('validation_failed')
  })

  test('an explicit null templateId behaves like omitting it', async () => {
    const created = await registry.create({
      displayName: 'Explicit null template',
      baseUrl: OPENAI_BASE_URL,
      keys: [{ upstreamKey: 'sk-test-null-template' }],
      templateId: null,
    })
    if (!created.ok) throw new Error(created.failure.code)
    expect(created.value.templateId).toBeNull()
  })

  test('templates from the registry are honored on the durable connection row', async () => {
    const custom: AdapterRegistry = new AdapterRegistry({
      inferenceAdapters: [
        [GENERIC_INFERENCE_ADAPTER_ID, createGenericInferenceAdapter()],
      ],
      usageAdapters: [[REACTIVE_ONLY_USAGE_ADAPTER_ID, { visibility: 'reactive_only' as const, async read() {
        return {
          ok: true,
          readings: [
            {
              unit: 'unknown',
              balance: null,
              used: null,
              limit: null,
              remainingPercent: null,
              plan: null,
              resetAt: null,
              scope: { kind: 'unknown' as const },
              keyId: null,
              confidence: 'unknown' as const,
              diagnostics: { source: 'mock' },
            },
          ],
        }
      } }]],
      providerTemplates: [safeTemplate('experimental')],
    })

    const opened2 = await sqliteEngine.open()
    try {
      const customRegistry = new ProviderRegistry({
        database: opened2.database,
        cipher: createSecretCipher(TEST_MASTER_KEY),
        keyProbe: fakeKeyProbe(),
        adapterRegistry: custom,
      })
      const created = await customRegistry.create({
        displayName: 'Experimental',
        baseUrl: OPENAI_BASE_URL,
        keys: [{ upstreamKey: 'sk-test-experimental' }],
        templateId: 'experimental',
      })
      if (!created.ok) throw new Error(created.failure.code)
      expect(created.value.templateId).toBe('experimental')

      const stored = await opened2.database.providers.getProvider(created.value.id)
      expect(stored?.templateId).toBe('experimental')
    } finally {
      await opened2.dispose()
    }
  })

  test('duplicating a templated connection preserves the templateId', async () => {
    const created = await registry.create({
      displayName: 'OpenAI original',
      baseUrl: OPENAI_BASE_URL,
      keys: [{ upstreamKey: 'sk-test-dup-original' }],
      templateId: 'openai',
    })
    if (!created.ok) throw new Error(created.failure.code)

    const dup = await registry.duplicate(created.value.id)
    if (!dup.ok) throw new Error(dup.failure.code)
    expect(dup.value.templateId).toBe('openai')
  })

  test('template defaults never include a secret', async () => {
    // The audit log records the create event with the providerId and
    // display name; the template defaults and the connection itself never
    // carry the Upstream Key, so the audit row must not echo it.
    const created = await registry.create({
      displayName: 'Template safety',
      baseUrl: OPENAI_BASE_URL,
      keys: [{ upstreamKey: 'sk-test-template-safety-key' }],
      templateId: 'openai',
    })
    if (!created.ok) throw new Error(created.failure.code)

    const events = await opened.database.audit.list({ limit: 50 })
    const detailText = events.map((event) => JSON.stringify(event.detail)).join('\n')
    expect(detailText).not.toContain('sk-test-template-safety-key')
  })
})