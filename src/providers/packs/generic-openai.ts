/**
 * Generic OpenAI-compatible Provider Pack: the safe default Iroha seeds a new
 * Provider with when the Owner names no brand. Bearer authentication, no
 * inferred capability defaults, reactive-only entitlement visibility, and the
 * OpenAI wire shape.
 */

import { createGenericInferenceAdapter } from '../../inference/generic-adapter.ts'
import { createGenericUsageAdapter } from '../../usage/generic-adapter.ts'
import {
  GENERIC_INFERENCE_ADAPTER_ID,
  GENERIC_PROVIDER_TEMPLATE_ID,
  REACTIVE_ONLY_USAGE_ADAPTER_ID,
} from '../adapter-ids.ts'
import type { ProviderPack } from './pack.ts'

export const genericOpenaiPack: ProviderPack = {
  id: GENERIC_PROVIDER_TEMPLATE_ID,
  template: {
    displayName: 'Generic OpenAI-compatible',
    description:
      'A safe default for any OpenAI-shaped service Iroha does not know by brand. Bearer authentication, no inferred capability defaults, and reactive-only entitlement visibility.',
    baseUrl: 'https://api.example.com/v1',
    authHeader: 'authorization',
    authPrefix: 'Bearer ',
    wireFormat: 'openai',
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
    brand: null,
  },
  inferenceAdapter: (options) => createGenericInferenceAdapter(options),
  usageAdapter: () => createGenericUsageAdapter(),
}
