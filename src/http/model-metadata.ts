import type { ModelCatalogMetadata, ProviderCapabilities } from '../persistence/index.ts'

export interface InlineModelMetadata {
  readonly normalized_name?: string
  readonly context_length?: number
  readonly max_input_tokens?: number
  readonly max_output_tokens?: number
  readonly chat?: 'ok' | 'unsupported'
  readonly architecture?: {
    readonly input_modalities?: readonly string[]
    readonly output_modalities?: readonly string[]
  }
}

export function inlineModelMetadata(
  metadata: ModelCatalogMetadata | null,
  overrides: Readonly<Partial<ProviderCapabilities>> | null = null,
): InlineModelMetadata {
  const chat = overrides?.chat === true
    ? 'ok'
    : overrides?.chat === false
      ? 'unsupported'
      : metadata?.chat
  const inputModalities = metadata?.inputModalities
  const outputModalities = metadata?.outputModalities
  if (metadata === null && chat === undefined) return {}
  return {
    ...(metadata?.normalizedName == null ? {} : { normalized_name: metadata.normalizedName }),
    ...(metadata?.contextLength == null ? {} : { context_length: metadata.contextLength }),
    ...(metadata?.maxInputTokens == null ? {} : { max_input_tokens: metadata.maxInputTokens }),
    ...(metadata?.maxOutputTokens == null ? {} : { max_output_tokens: metadata.maxOutputTokens }),
    ...(chat == null ? {} : { chat }),
    ...(inputModalities == null && outputModalities == null
      ? {}
      : {
          architecture: {
            ...(inputModalities == null ? {} : { input_modalities: inputModalities }),
            ...(outputModalities == null ? {} : { output_modalities: outputModalities }),
          },
        }),
  }
}
