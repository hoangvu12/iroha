import { describe, expect, test } from 'bun:test'
import { createGenericInferenceAdapter, type InferenceAdapter } from '../../src/inference/index.ts'
import {
  AdapterRegistry,
  AdapterRegistryValidationError,
} from '../../src/providers/adapter-registry.ts'
import { createBuiltInAdapterRegistry } from '../../src/providers/index.ts'
import {
  BUILT_IN_PROVIDER_TEMPLATES,
  GENERIC_INFERENCE_ADAPTER_ID,
  REACTIVE_ONLY_USAGE_ADAPTER_ID,
  type ProviderTemplate,
} from '../../src/providers/templates.ts'
import { createGenericUsageAdapter } from '../../src/usage/generic-adapter.ts'
import type { UsageAdapter } from '../../src/usage/index.ts'

const STANDARD_INFERENCE: ReadonlyArray<readonly [string, InferenceAdapter]> = [
  [GENERIC_INFERENCE_ADAPTER_ID, createGenericInferenceAdapter()],
]

const STANDARD_USAGE: ReadonlyArray<readonly [string, UsageAdapter]> = [
  [REACTIVE_ONLY_USAGE_ADAPTER_ID, createGenericUsageAdapter()],
]

/** A template that points at the built-in adapters — safe default for tests. */
function safeTemplate(id: string, over: Partial<ProviderTemplate> = {}): ProviderTemplate {
  return {
    id,
    displayName: `Template ${id}`,
    description: `Template ${id} for tests.`,
    baseUrl: 'https://api.example.com/v1',
    authHeader: 'authorization',
    authPrefix: 'Bearer ',
    capabilities: {
      chat: false,
      streaming: false,
      tools: false,
      structuredOutput: false,
      responses: false,
    },
    knownModels: [],
    inferenceAdapterId: GENERIC_INFERENCE_ADAPTER_ID,
    usageAdapterId: REACTIVE_ONLY_USAGE_ADAPTER_ID,
    ...over,
  }
}

describe('the Adapter Registry', () => {
  test('the built-in registry exposes every built-in template and the generic adapters', () => {
    const registry = createBuiltInAdapterRegistry()

    expect(registry.inferenceAdapter(GENERIC_INFERENCE_ADAPTER_ID)).not.toBeNull()
    expect(registry.usageAdapter(REACTIVE_ONLY_USAGE_ADAPTER_ID)).not.toBeNull()

    const templates = registry.listProviderTemplates()
    const ids = new Set(templates.map((template) => template.id))
    for (const built of BUILT_IN_PROVIDER_TEMPLATES) {
      expect(ids.has(built.id)).toBe(true)
    }
  })

  test('listProviderTemplates returns templates in declaration order', () => {
    const registry = createBuiltInAdapterRegistry()
    const ids = registry.listProviderTemplates().map((template) => template.id)
    expect(ids).toEqual(BUILT_IN_PROVIDER_TEMPLATES.map((template) => template.id))
  })

  test('looks up adapters and templates by id, returns null for unknown ids', () => {
    const registry = createBuiltInAdapterRegistry()
    expect(registry.providerTemplate('openai')?.id).toBe('openai')
    expect(registry.providerTemplate('not-a-template')).toBeNull()
    expect(registry.inferenceAdapter('not-an-adapter')).toBeNull()
    expect(registry.usageAdapter('not-an-adapter')).toBeNull()
  })

  test('rejects duplicate inference adapter ids at construction', () => {
    expect(
      () =>
        new AdapterRegistry({
          inferenceAdapters: [
            [GENERIC_INFERENCE_ADAPTER_ID, createGenericInferenceAdapter()],
            ['dup-id', createGenericInferenceAdapter()],
            ['dup-id', createGenericInferenceAdapter()],
          ],
          usageAdapters: STANDARD_USAGE,
          providerTemplates: [],
        }),
    ).toThrow(AdapterRegistryValidationError)
  })

  test('rejects duplicate usage adapter ids at construction', () => {
    expect(
      () =>
        new AdapterRegistry({
          inferenceAdapters: STANDARD_INFERENCE,
          usageAdapters: [
            [REACTIVE_ONLY_USAGE_ADAPTER_ID, createGenericUsageAdapter()],
            ['dup-usage', createGenericUsageAdapter()],
            ['dup-usage', createGenericUsageAdapter()],
          ],
          providerTemplates: [],
        }),
    ).toThrow(AdapterRegistryValidationError)
  })

  test('rejects duplicate provider template ids at construction', () => {
    expect(
      () =>
        new AdapterRegistry({
          inferenceAdapters: STANDARD_INFERENCE,
          usageAdapters: STANDARD_USAGE,
          providerTemplates: [safeTemplate('first'), safeTemplate('first')],
        }),
    ).toThrow(AdapterRegistryValidationError)
  })

  test('rejects a template that names an unknown inference adapter', () => {
    let captured: unknown
    try {
      new AdapterRegistry({
        inferenceAdapters: STANDARD_INFERENCE,
        usageAdapters: STANDARD_USAGE,
        providerTemplates: [
          safeTemplate('bad-template', { inferenceAdapterId: 'unknown-inference-adapter' }),
        ],
      })
    } catch (error) {
      captured = error
    }

    expect(captured).toBeInstanceOf(AdapterRegistryValidationError)
    const problems = (captured as AdapterRegistryValidationError).problems
    expect(problems.some((p) => p.includes('unknown inference adapter'))).toBe(true)
  })

  test('rejects a template that names an unknown usage adapter', () => {
    let captured: unknown
    try {
      new AdapterRegistry({
        inferenceAdapters: STANDARD_INFERENCE,
        usageAdapters: STANDARD_USAGE,
        providerTemplates: [
          safeTemplate('bad-template', { usageAdapterId: 'unknown-usage-adapter' }),
        ],
      })
    } catch (error) {
      captured = error
    }

    expect(captured).toBeInstanceOf(AdapterRegistryValidationError)
    const problems = (captured as AdapterRegistryValidationError).problems
    expect(problems.some((p) => p.includes('unknown usage adapter'))).toBe(true)
  })

  test('a template with usageAdapterId null is allowed when no usage adapter exists', () => {
    const registry = new AdapterRegistry({
      inferenceAdapters: STANDARD_INFERENCE,
      usageAdapters: STANDARD_USAGE,
      providerTemplates: [safeTemplate('explicit-null', { usageAdapterId: null })],
    })
    expect(registry.providerTemplate('explicit-null')?.usageAdapterId).toBeNull()
  })

  test('a template may omit a usage adapter id entirely (treated as null)', () => {
    expect(
      () =>
        new AdapterRegistry({
          inferenceAdapters: STANDARD_INFERENCE,
          usageAdapters: STANDARD_USAGE,
          providerTemplates: [safeTemplate('omitted-usage')],
        }),
    ).not.toThrow()
  })

  test('rejects an adapter id that is blank or contains whitespace', () => {
    expect(
      () =>
        new AdapterRegistry({
          inferenceAdapters: [['', createGenericInferenceAdapter()]],
          usageAdapters: [],
          providerTemplates: [],
        }),
    ).toThrow(AdapterRegistryValidationError)

    expect(
      () =>
        new AdapterRegistry({
          inferenceAdapters: [['has space', createGenericInferenceAdapter()]],
          usageAdapters: [],
          providerTemplates: [],
        }),
    ).toThrow(AdapterRegistryValidationError)
  })

  test('rejects a template id that is blank or contains whitespace', () => {
    expect(
      () =>
        new AdapterRegistry({
          inferenceAdapters: STANDARD_INFERENCE,
          usageAdapters: STANDARD_USAGE,
          providerTemplates: [safeTemplate('  has space  ')],
        }),
    ).toThrow(AdapterRegistryValidationError)
  })

  test('lists every problem at once so a misconfigured runtime can fix all in one pass', () => {
    let captured: unknown
    try {
      new AdapterRegistry({
        inferenceAdapters: [
          ['', createGenericInferenceAdapter()],
          ['bad space', createGenericInferenceAdapter()],
        ],
        usageAdapters: [
          [REACTIVE_ONLY_USAGE_ADAPTER_ID, createGenericUsageAdapter()],
          ['dup-usage', createGenericUsageAdapter()],
          ['dup-usage', createGenericUsageAdapter()],
        ],
        providerTemplates: [
          safeTemplate('duplicated', { inferenceAdapterId: 'unknown-adapter' }),
          safeTemplate('duplicated'),
          safeTemplate('   '),
        ],
      })
    } catch (error) {
      captured = error
    }

    expect(captured).toBeInstanceOf(AdapterRegistryValidationError)
    const error = captured as AdapterRegistryValidationError
    expect(error.problems.length).toBeGreaterThanOrEqual(4)
    expect(error.message).toContain('Adapter registry is malformed')
  })

  test('every built-in template passes registry validation', () => {
    expect(() => createBuiltInAdapterRegistry()).not.toThrow()
  })

  test('a registry without any inference adapters rejects every template that references one', () => {
    let captured: unknown
    try {
      new AdapterRegistry({
        inferenceAdapters: [],
        usageAdapters: STANDARD_USAGE,
        providerTemplates: BUILT_IN_PROVIDER_TEMPLATES,
      })
    } catch (error) {
      captured = error
    }

    expect(captured).toBeInstanceOf(AdapterRegistryValidationError)
    const problems = (captured as AdapterRegistryValidationError).problems
    expect(problems.some((p) => p.includes('unknown inference adapter'))).toBe(true)
  })
})