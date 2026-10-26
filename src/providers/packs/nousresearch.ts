/**
 * Nous Research Provider Pack: the Nous Research inference API's
 * OpenAI-compatible surface. Bearer authentication, a typed Inference Adapter
 * that reads its out-of-credit 404 envelope so an empty account parks instead
 * of answering "model unavailable", and reactive-only entitlement visibility —
 * Nous Research exposes no entitlement API.
 */

import { createNousResearchInferenceAdapter } from '../../inference/nousresearch-adapter.ts'
import { createGenericUsageAdapter } from '../../usage/generic-adapter.ts'
import { REACTIVE_ONLY_USAGE_ADAPTER_ID } from '../adapter-ids.ts'
import type { ProviderPack } from './pack.ts'

export const nousResearchPack: ProviderPack = {
  id: 'nousresearch',
  template: {
    displayName: 'Nous Research',
    description:
      'Nous Research’s OpenAI-compatible inference API. Bearer authentication, chat and streaming, and a typed failure classifier that reads its insufficient-credits 404 envelope so an account without credits parks instead of answering “model unavailable”.',
    baseUrl: 'https://inference-api.nousresearch.com/v1',
    authHeader: 'authorization',
    authPrefix: 'Bearer ',
    wireFormat: 'openai',
    capabilities: {
      chat: true,
      streaming: true,
      tools: false,
      structuredOutput: false,
      responses: false,
    },
    knownModels: [],
    modelDiscovery: 'supported',
    inferenceAdapterId: 'nousresearch-inference-adapter',
    usageAdapterId: REACTIVE_ONLY_USAGE_ADAPTER_ID,
    brand: { domain: 'nousresearch.com', accentColor: '#111827' },
  },
  inferenceAdapter: (options) => createNousResearchInferenceAdapter(options),
  usageAdapter: () => createGenericUsageAdapter(),
}
