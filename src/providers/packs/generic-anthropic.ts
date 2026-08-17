/**
 * Generic Anthropic-compatible Provider Pack: the safe default Iroha seeds a new
 * Provider with when the Owner names an Anthropic-shaped service by no known
 * brand. x-api-key authentication, no inferred capability defaults, reactive-only
 * entitlement visibility, and the Anthropic wire shape.
 */

import { createAnthropicInferenceAdapter } from '../../inference/anthropic-adapter.ts'
import { createGenericUsageAdapter } from '../../usage/generic-adapter.ts'
import {
  ANTHROPIC_INFERENCE_ADAPTER_ID,
  REACTIVE_ONLY_USAGE_ADAPTER_ID,
} from '../adapter-ids.ts'
import type { ProviderPack } from './pack.ts'

export const genericAnthropicPack: ProviderPack = {
  id: 'generic-anthropic-compatible',
  template: {
    displayName: 'Generic Anthropic-compatible',
    description:
      'A safe default for any Anthropic-shaped service Iroha does not know by brand. x-api-key authentication, no inferred capability defaults, and reactive-only entitlement visibility.',
    baseUrl: 'https://api.example.com/v1',
    authHeader: 'x-api-key',
    authPrefix: '',
    wireFormat: 'anthropic',
    capabilities: {
      chat: false,
      streaming: false,
      tools: false,
      structuredOutput: false,
      responses: false,
    },
    knownModels: [],
    inferenceAdapterId: ANTHROPIC_INFERENCE_ADAPTER_ID,
    usageAdapterId: REACTIVE_ONLY_USAGE_ADAPTER_ID,
    brand: null,
  },
  inferenceAdapter: (options) => createAnthropicInferenceAdapter(options),
  usageAdapter: () => createGenericUsageAdapter(),
}
