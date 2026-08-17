/**
 * OpenAI Provider Pack: OpenAI's first-party OpenAI-compatible surface. Bearer
 * authentication, the full capability set Iroha knows OpenAI supports, the
 * generic Inference Adapter, and reactive-only entitlement visibility.
 */

import { createGenericInferenceAdapter } from '../../inference/generic-adapter.ts'
import { createGenericUsageAdapter } from '../../usage/generic-adapter.ts'
import { GENERIC_INFERENCE_ADAPTER_ID, REACTIVE_ONLY_USAGE_ADAPTER_ID } from '../adapter-ids.ts'
import type { ProviderPack } from './pack.ts'

export const openaiPack: ProviderPack = {
  id: 'openai',
  template: {
    displayName: 'OpenAI',
    description:
      'OpenAI’s public OpenAI-compatible surface. Bearer authentication and the full capability set Iroha knows OpenAI supports.',
    baseUrl: 'https://api.openai.com/v1',
    authHeader: 'authorization',
    authPrefix: 'Bearer ',
    wireFormat: 'openai',
    capabilities: {
      chat: true,
      streaming: true,
      tools: true,
      structuredOutput: true,
      responses: true,
    },
    knownModels: [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4.1-nano',
      'o1',
      'o1-mini',
      'o3',
      'o3-mini',
      'o4-mini',
    ],
    inferenceAdapterId: GENERIC_INFERENCE_ADAPTER_ID,
    usageAdapterId: REACTIVE_ONLY_USAGE_ADAPTER_ID,
    brand: { domain: 'openai.com', accentColor: '#10A37F' },
  },
  inferenceAdapter: (options) => createGenericInferenceAdapter(options),
  usageAdapter: () => createGenericUsageAdapter(),
}
