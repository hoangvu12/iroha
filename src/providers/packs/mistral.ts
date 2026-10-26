/**
 * Mistral Provider Pack: Mistral's first-party OpenAI-compatible surface.
 * Bearer authentication, the typed Mistral Inference Adapter for its billing
 * 402 envelope, and reactive-only entitlement visibility — Mistral exposes no
 * entitlement API, so a spending-capped key parks on the inference refusal
 * itself and recovers on the Owner's next controlled trial.
 */

import { createMistralInferenceAdapter } from '../../inference/mistral-adapter.ts'
import { createGenericUsageAdapter } from '../../usage/generic-adapter.ts'
import { REACTIVE_ONLY_USAGE_ADAPTER_ID } from '../adapter-ids.ts'
import type { ProviderPack } from './pack.ts'

export const mistralPack: ProviderPack = {
  id: 'mistral',
  template: {
    displayName: 'Mistral',
    description:
      'Mistral’s public OpenAI-compatible surface. Bearer authentication, the full capability set Iroha knows Mistral supports, and a typed failure classifier that reads its billing 402 envelope so a spending-capped key parks instead of burning an Attempt on every Request.',
    baseUrl: 'https://api.mistral.ai/v1',
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
    knownModels: [
      'mistral-large-latest',
      'mistral-medium-latest',
      'mistral-small-latest',
      'magistral-medium-latest',
      'devstral-medium-latest',
      'codestral-latest',
      'open-mistral-nemo',
      'ministral-8b-latest',
      'ministral-3b-latest',
      'pixtral-large-latest',
    ],
    modelDiscovery: 'supported',
    inferenceAdapterId: 'mistral-inference-adapter',
    usageAdapterId: REACTIVE_ONLY_USAGE_ADAPTER_ID,
    brand: { domain: 'mistral.ai', accentColor: '#FF7000' },
  },
  inferenceAdapter: (options) => createMistralInferenceAdapter(options),
  usageAdapter: () => createGenericUsageAdapter(),
}
