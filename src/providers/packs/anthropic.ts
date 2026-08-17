/**
 * Anthropic Provider Pack: the first-party Anthropic brand. Uses the
 * `x-api-key` authentication header, the Anthropic Messages wire shape, and the
 * typed Anthropic Inference Adapter that translates OpenAI-shape requests and
 * responses to and from the Anthropic Messages envelope.
 */

import { createAnthropicInferenceAdapter } from '../../inference/anthropic-adapter.ts'
import { createGenericUsageAdapter } from '../../usage/generic-adapter.ts'
import { REACTIVE_ONLY_USAGE_ADAPTER_ID } from '../adapter-ids.ts'
import type { ProviderPack } from './pack.ts'

export const anthropicPack: ProviderPack = {
  id: 'anthropic',
  template: {
    displayName: 'Anthropic',
    description:
      'Anthropic’s first-party API. Authentication uses the `x-api-key` header; the typed Anthropic Inference Adapter translates OpenAI-shape requests and responses to and from the Anthropic Messages envelope.',
    baseUrl: 'https://api.anthropic.com/v1',
    authHeader: 'x-api-key',
    authPrefix: '',
    wireFormat: 'anthropic',
    capabilities: {
      chat: true,
      streaming: true,
      tools: true,
      structuredOutput: true,
      responses: true,
    },
    knownModels: [
      'anthropic-opus-5',
      'anthropic-sonnet-5',
      'anthropic-fable-5',
      'anthropic-mythos-5',
      'anthropic-opus-4-8',
      'anthropic-opus-4-7',
      'anthropic-mythos-preview',
      'anthropic-opus-4-6',
      'anthropic-sonnet-4-6',
      'anthropic-haiku-4-5',
      'anthropic-haiku-4-5-20251001',
      'anthropic-opus-4-5',
      'anthropic-opus-4-5-20251101',
      'anthropic-sonnet-4-5',
      'anthropic-sonnet-4-5-20250929',
    ],
    inferenceAdapterId: 'anthropic-inference-adapter',
    usageAdapterId: REACTIVE_ONLY_USAGE_ADAPTER_ID,
    brand: { domain: 'anthropic.com', accentColor: '#D97757' },
  },
  inferenceAdapter: (options) => createAnthropicInferenceAdapter(options),
  usageAdapter: () => createGenericUsageAdapter(),
}
