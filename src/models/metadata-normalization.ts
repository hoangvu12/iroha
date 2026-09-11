import type { ModelCatalogMetadata } from '../persistence/index.ts'

export function readModelChatCapability(model: Record<string, unknown>): 'ok' | 'unsupported' | null {
  const capabilities = record(model.capabilities)
  const explicit = chatValue(model.chat)
    ?? chatValue(capabilities.chat)
    ?? chatValue(capabilities.completion_chat)
  if (explicit !== null) return explicit

  const endpoints = stringArray(model.supported_endpoints)
  if (endpoints !== null) {
    return endpoints.some((endpoint) => /(^|\/)chat\/completions\/?$/i.test(endpoint))
      ? 'ok'
      : 'unsupported'
  }

  const outputModalities = readOutputModalities(model)
  if (outputModalities !== null && !outputModalities.includes('text')) return 'unsupported'
  if (outputModalities?.includes('text') && hasGenerativeEvidence(model)) return 'ok'
  return null
}

export function readInputModalities(model: Record<string, unknown>): readonly string[] | null {
  const architecture = record(model.architecture)
  const modalities = record(model.modalities)
  return stringArray(architecture.input_modalities)
    ?? stringArray(model.input_modalities)
    ?? stringArray(modalities.input)
}

export function readOutputModalities(model: Record<string, unknown>): readonly string[] | null {
  const architecture = record(model.architecture)
  const modalities = record(model.modalities)
  return stringArray(architecture.output_modalities)
    ?? stringArray(model.output_modalities)
    ?? stringArray(modalities.output)
}

export function mergeModelMetadata(
  primary: ModelCatalogMetadata | undefined,
  supplement: ModelCatalogMetadata,
): ModelCatalogMetadata {
  return {
    normalizedName: primary?.normalizedName ?? supplement.normalizedName,
    contextLength: primary?.contextLength ?? supplement.contextLength,
    maxInputTokens: primary?.maxInputTokens ?? supplement.maxInputTokens,
    maxOutputTokens: primary?.maxOutputTokens ?? supplement.maxOutputTokens,
    chat: primary?.chat ?? supplement.chat ?? null,
    inputModalities: primary?.inputModalities ?? supplement.inputModalities ?? null,
    outputModalities: primary?.outputModalities ?? supplement.outputModalities ?? null,
  }
}

function hasGenerativeEvidence(model: Record<string, unknown>): boolean {
  for (const field of ['tool_call', 'reasoning', 'temperature', 'structured_output']) {
    if (model[field] === true) return true
  }
  const features = stringArray(model.supported_features)
  return features?.some((feature) => ['tools', 'json_mode', 'reasoning'].includes(feature)) ?? false
}

function chatValue(value: unknown): 'ok' | 'unsupported' | null {
  if (value === true) return 'ok'
  if (value === false) return 'unsupported'
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase().replace(/[ -]/g, '_')
  if (['ok', 'supported', 'available', 'enabled', 'true'].includes(normalized)) return 'ok'
  if (['unsupported', 'not_supported', 'unavailable', 'disabled', 'false'].includes(normalized)) {
    return 'unsupported'
  }
  return null
}

function stringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null
  const values = [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== ''))]
  return values.length === 0 ? null : values
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}
