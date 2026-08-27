/**
 * Z.ai / BigModel Provider Pack: the Zhipu AI GLM Coding Plan brand. Bearer
 * authentication over the OpenAI wire shape, the typed Z.ai Inference Adapter
 * for documented error-code capacity evidence, and the authoritative GLM
 * Coding Plan quota Usage Adapter shared by Z.ai and BigModel.
 */

import { createZaiInferenceAdapter } from '../../inference/zai-adapter.ts'
import { createZaiUsageAdapter } from '../../usage/zai-usage-adapter.ts'
import type { ProviderPack } from './pack.ts'

export const zaiPack: ProviderPack = {
  id: 'zai',
  template: {
    displayName: 'Z.ai / BigModel',
    description:
      'Zhipu AI GLM Coding Plan via Z.ai. Override the base URL with https://open.bigmodel.cn/api/coding/paas/v4 for a mainland BigModel key; subscription quota is read per key, while pay-as-you-go credit remains unavailable.',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    authHeader: 'authorization',
    authPrefix: 'Bearer ',
    wireFormat: 'openai',
    capabilities: {
      chat: true,
      streaming: true,
      tools: true,
      structuredOutput: false,
      responses: false,
    },
    knownModels: ['glm-5.3', 'glm-5.1', 'glm-5-turbo', 'glm-5', 'glm-4.7', 'glm-4.6', 'glm-4.5', 'glm-4.5-air'],
    modelDiscovery: 'best_effort',
    modelDiscoveryBasePath: '/api/coding/paas/v4',
    inferenceAdapterId: 'zai-inference-adapter',
    usageAdapterId: 'zai-usage-adapter',
    brand: { domain: 'z.ai', accentColor: '#0EA5E9' },
  },
  inferenceAdapter: (options) => createZaiInferenceAdapter(options),
  usageAdapter: (options) => createZaiUsageAdapter(options),
}
