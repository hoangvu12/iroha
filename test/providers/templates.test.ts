import { describe, expect, test } from 'bun:test'
import {
  ANTHROPIC_INFERENCE_ADAPTER_ID,
  DASHSCOPE_INFERENCE_ADAPTER_ID,
  BUILT_IN_PROVIDER_TEMPLATES,
  findBuiltInTemplate,
  GENERIC_INFERENCE_ADAPTER_ID,
  MINIMAX_INFERENCE_ADAPTER_ID,
  MINIMAX_USAGE_ADAPTER_ID,
  REACTIVE_ONLY_USAGE_ADAPTER_ID,
  ZAI_INFERENCE_ADAPTER_ID,
  ZAI_USAGE_ADAPTER_ID,
  type ProviderTemplate,
} from '../../src/providers/templates.ts'

const REQUIRED_TEMPLATE_IDS = [
  'generic-openai-compatible',
  'generic-anthropic-compatible',
  'openai',
  'openrouter',
  'dashscope',
  'MiniMax',
  'zai',
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

  test('every built-in template references a registered Inference Adapter', () => {
    // The Anthropic and Generic Anthropic-compatible templates reference the
    // typed Anthropic Inference Adapter; every other built-in template uses
    // the generic one (except DashScope and MiniMax which have their own).
    for (const template of BUILT_IN_PROVIDER_TEMPLATES) {
      if (template.id === 'anthropic' || template.id === 'generic-anthropic-compatible') {
        expect(template.inferenceAdapterId).toBe(ANTHROPIC_INFERENCE_ADAPTER_ID)
      } else if (template.id === 'dashscope') {
        expect(template.inferenceAdapterId).toBe(DASHSCOPE_INFERENCE_ADAPTER_ID)
      } else if (template.id === 'MiniMax') {
        expect(template.inferenceAdapterId).toBe(MINIMAX_INFERENCE_ADAPTER_ID)
      } else if (template.id === 'zai') {
        expect(template.inferenceAdapterId).toBe(ZAI_INFERENCE_ADAPTER_ID)
      } else {
        expect(template.inferenceAdapterId).toBe(GENERIC_INFERENCE_ADAPTER_ID)
      }
    }
  })

  test('every built-in template that has no documented entitlement API declares the reactive-only Usage Adapter honestly', () => {
    for (const template of BUILT_IN_PROVIDER_TEMPLATES) {
      // MiniMax exposes a documented entitlement API; every other built-in
      // template is honest about having no authority and points at the
      // reactive-only adapter.
      if (template.id === 'MiniMax') {
        expect(template.usageAdapterId).toBe(MINIMAX_USAGE_ADAPTER_ID)
      } else if (template.id === 'zai') {
        expect(template.usageAdapterId).toBe(ZAI_USAGE_ADAPTER_ID)
      } else {
        expect(template.usageAdapterId).toBe(REACTIVE_ONLY_USAGE_ADAPTER_ID)
      }
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

  test('the DashScope template uses the Alibaba Cloud Mail Logo Domain', () => {
    expect(findBuiltInTemplate('dashscope')?.brand?.domain).toBe('alibabacloudmail.com')
  })

  test('the Anthropic template authenticates with x-api-key and advertises every capability', () => {
    const anthropic = findBuiltInTemplate('anthropic') as ProviderTemplate
    expect(anthropic.authHeader).toBe('x-api-key')
    expect(anthropic.authPrefix).toBe('')
    expect(anthropic.baseUrl).toBe('https://api.anthropic.com/v1')
    // The typed adapter translates OpenAI-shape to Anthropic-shape at the
    // boundary, so every public surface is reachable and the template
    // advertises all five capability flags.
    expect(anthropic.capabilities.chat).toBe(true)
    expect(anthropic.capabilities.streaming).toBe(true)
    expect(anthropic.capabilities.tools).toBe(true)
    expect(anthropic.capabilities.structuredOutput).toBe(true)
    expect(anthropic.capabilities.responses).toBe(true)
    expect(anthropic.knownModels.length).toBeGreaterThan(0)
    expect(anthropic.knownModels).toContain('anthropic-opus-5')
    // Anthropic exposes no entitlement API; the reactive-only generic
    // Usage Adapter is the honest default.
    expect(anthropic.usageAdapterId).toBe(REACTIVE_ONLY_USAGE_ADAPTER_ID)
  })

  test('the Generic Anthropic-compatible template uses x-api-key auth and the Anthropic Inference Adapter', () => {
    const genericAnthropic = findBuiltInTemplate('generic-anthropic-compatible') as ProviderTemplate
    expect(genericAnthropic.authHeader).toBe('x-api-key')
    expect(genericAnthropic.authPrefix).toBe('')
    // The generic template has no brand and no inferred capability defaults,
    // matching the Generic OpenAI-compatible pattern.
    expect(genericAnthropic.brand).toBeNull()
    expect(genericAnthropic.capabilities.chat).toBe(false)
    expect(genericAnthropic.capabilities.streaming).toBe(false)
    expect(genericAnthropic.capabilities.tools).toBe(false)
    expect(genericAnthropic.capabilities.structuredOutput).toBe(false)
    expect(genericAnthropic.capabilities.responses).toBe(false)
    // The typed Anthropic Inference Adapter handles the protocol translation,
    // so users can call both /v1/chat/completions and /v1/messages.
    expect(genericAnthropic.inferenceAdapterId).toBe(ANTHROPIC_INFERENCE_ADAPTER_ID)
    // No known models; the generic template is honest about not knowing the upstream.
    expect(genericAnthropic.knownModels.length).toBe(0)
    // No entitlement API; the reactive-only Usage Adapter is the honest default.
    expect(genericAnthropic.usageAdapterId).toBe(REACTIVE_ONLY_USAGE_ADAPTER_ID)
  })
})
