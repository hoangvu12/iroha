import { describe, expect, test } from 'bun:test'
import {
  BUILT_IN_PROVIDER_TEMPLATES,
  findBuiltInTemplate,
  GENERIC_INFERENCE_ADAPTER_ID,
  REACTIVE_ONLY_USAGE_ADAPTER_ID,
  type ProviderTemplate,
} from '../../src/providers/templates.ts'

const REQUIRED_TEMPLATE_IDS = [
  'generic-openai-compatible',
  'openai',
  'openrouter',
  'MiniMax',
] as const

describe('the built-in Provider Templates', () => {
  test('covers every required template id', () => {
    const ids = new Set(BUILT_IN_PROVIDER_TEMPLATES.map((template) => template.id))
    for (const id of REQUIRED_TEMPLATE_IDS) {
      expect(ids.has(id)).toBe(true)
    }
  })

  test('orders the generic default first so the Owner is never nudged toward a brand', () => {
    expect(BUILT_IN_PROVIDER_TEMPLATES[0]?.id).toBe('generic-openai-compatible')
  })

  test('never carries an account, secret, or static header value', () => {
    for (const template of BUILT_IN_PROVIDER_TEMPLATES) {
      // No template may ship a base URL with a key in it.
      expect(template.baseUrl).not.toMatch(/sk-|key=|api[-_]?key=/i)
      // No template may ship a known model list that looks like a secret.
      for (const model of template.knownModels) {
        expect(model).not.toMatch(/sk-|secret|token/i)
      }
      // No template may claim a non-default authentication prefix that already
      // includes placeholder material — every template's authPrefix is either
      // empty or the canonical Bearer scheme.
      expect(['Bearer ', '']).toContain(template.authPrefix)
      // No template may default to insecure HTTP: the Owner must opt in.
      expect(template.baseUrl).toMatch(/^https:\/\//)
    }
  })

  test('every built-in template references the generic Inference Adapter', () => {
    for (const template of BUILT_IN_PROVIDER_TEMPLATES) {
      expect(template.inferenceAdapterId).toBe(GENERIC_INFERENCE_ADAPTER_ID)
    }
  })

  test('every built-in template declares the reactive-only Usage Adapter honestly', () => {
    for (const template of BUILT_IN_PROVIDER_TEMPLATES) {
      expect(template.usageAdapterId).toBe(REACTIVE_ONLY_USAGE_ADAPTER_ID)
    }
  })

  test('every known-model id is well-formed and at most 128 characters', () => {
    for (const template of BUILT_IN_PROVIDER_TEMPLATES) {
      for (const model of template.knownModels) {
        expect(model.length).toBeGreaterThan(0)
        expect(model.length).toBeLessThanOrEqual(128)
      }
    }
  })

  test('every template has a non-empty display name and description', () => {
    for (const template of BUILT_IN_PROVIDER_TEMPLATES) {
      expect(template.displayName.length).toBeGreaterThan(0)
      expect(template.description.length).toBeGreaterThan(0)
    }
  })

  test('every template id is stable, slug-shaped, and unique', () => {
    const seen = new Set<string>()
    for (const template of BUILT_IN_PROVIDER_TEMPLATES) {
      // Brand-named ids keep their casing; kebab-case ids keep their dashes.
      expect(template.id).toMatch(/^[A-Za-z0-9-]+$/)
      expect(template.id).not.toMatch(/\s/)
      expect(seen.has(template.id)).toBe(false)
      seen.add(template.id)
    }
  })

  test('every template carries a capability claim (unknown-off is still a claim)', () => {
    for (const template of BUILT_IN_PROVIDER_TEMPLATES) {
      for (const value of Object.values(template.capabilities)) {
        expect(typeof value).toBe('boolean')
      }
    }
  })

  test('findBuiltInTemplate returns the same object the array exposes', () => {
    for (const template of BUILT_IN_PROVIDER_TEMPLATES) {
      expect(findBuiltInTemplate(template.id)).toBe(template)
    }
  })

  test('findBuiltInTemplate returns null for unknown ids', () => {
    expect(findBuiltInTemplate('not-a-real-template')).toBeNull()
    expect(findBuiltInTemplate('')).toBeNull()
    expect(findBuiltInTemplate('   ')).toBeNull()
  })

  test('the OpenAI template carries the curated model list Iroha has reviewed', () => {
    const openai = findBuiltInTemplate('openai') as ProviderTemplate
    expect(openai.knownModels.length).toBeGreaterThan(0)
    expect(openai.knownModels).toContain('gpt-4o-mini')
    // OpenAI's curated list is conservative: every capability Iroha knows
    // OpenAI supports is true.
    expect(openai.capabilities.chat).toBe(true)
    expect(openai.capabilities.streaming).toBe(true)
    expect(openai.capabilities.tools).toBe(true)
    expect(openai.capabilities.responses).toBe(true)
  })
})