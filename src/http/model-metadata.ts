import type { ModelCatalogMetadata } from '../persistence/index.ts'

export interface InlineModelMetadata {
  readonly normalized_name?: string
  readonly context_length?: number
  readonly max_input_tokens?: number
  readonly max_output_tokens?: number
}

export function inlineModelMetadata(metadata: ModelCatalogMetadata | null): InlineModelMetadata {
  if (metadata === null) return {}
  return {
    ...(metadata.normalizedName === null ? {} : { normalized_name: metadata.normalizedName }),
    ...(metadata.contextLength === null ? {} : { context_length: metadata.contextLength }),
    ...(metadata.maxInputTokens === null ? {} : { max_input_tokens: metadata.maxInputTokens }),
    ...(metadata.maxOutputTokens === null ? {} : { max_output_tokens: metadata.maxOutputTokens }),
  }
}
