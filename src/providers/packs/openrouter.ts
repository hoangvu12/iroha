/**
 * OpenRouter Provider Pack: OpenRouter's OpenAI-compatible surface. Bearer
 * authentication and reactive-only entitlement visibility, with the catalog
 * merging whatever OpenRouter reports on refresh.
 */

import { createGenericInferenceAdapter } from '../../inference/generic-adapter.ts'
import { createGenericUsageAdapter } from '../../usage/generic-adapter.ts'
import {
  GENERIC_INFERENCE_ADAPTER_ID,
  REACTIVE_ONLY_USAGE_ADAPTER_ID,
} from '../adapter-ids.ts'
import type { ProviderPack } from './pack.ts'

export const openrouterPack: ProviderPack = {
  id: 'openrouter',
  template: {
    displayName: 'OpenRouter',
    description:
      'OpenRouter’s OpenAI-compatible surface. Bearer authentication; the catalog merges whatever OpenRouter reports on refresh.',
    baseUrl: 'https://openrouter.ai/api/v1',
    authHeader: 'authorization',
    authPrefix: 'Bearer ',
    wireFormat: 'openai',
    capabilities: {
      chat: true,
      streaming: true,
      tools: true,
      structuredOutput: true,
      responses: false,
    },
    knownModels: [],
    inferenceAdapterId: GENERIC_INFERENCE_ADAPTER_ID,
    usageAdapterId: REACTIVE_ONLY_USAGE_ADAPTER_ID,
    brand: { domain: 'openrouter.ai', accentColor: '#3D55E6' },
  },
  inferenceAdapter: (options) => createGenericInferenceAdapter(options),
  usageAdapter: () => createGenericUsageAdapter(),
}
