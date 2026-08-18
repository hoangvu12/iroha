/**
 * DashScope Provider Pack: Alibaba Cloud's international OpenAI-compatible
 * endpoint. Bearer authentication over the OpenAI wire shape, a typed inference
 * adapter with bounded recovery from intermittent content-inspection failures,
 * and reactive-only entitlement visibility.
 *
 * DashScope entitles each Upstream Key separately, so this Pack declares
 * `modelAvailability: 'key'` (ADR-0023). Its keys therefore carry their own Key
 * Model Availability and a Request prefers the keys known to carry its model.
 */

import { createDashscopeInferenceAdapter } from '../../inference/dashscope-adapter.ts'
import { createGenericUsageAdapter } from '../../usage/generic-adapter.ts'
import { REACTIVE_ONLY_USAGE_ADAPTER_ID } from '../adapter-ids.ts'
import type { ProviderPack } from './pack.ts'

export const dashscopePack: ProviderPack = {
  id: 'dashscope',
  template: {
    displayName: 'DashScope',
    description:
      'Alibaba Cloud DashScope international OpenAI-compatible endpoint with bounded recovery from intermittent content-inspection failures.',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
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
    // Measured against a 23-key Provider: these six are the only models every
    // Upstream Key could call. The full union across keys was 250.
    knownModels: [
      'qwen3-coder-next',
      'qwen3-coder-plus',
      'qwen3-max-2026-01-23',
      'qwen3.5-plus',
      'qwen3.6-plus',
      'qwen3.7-plus',
    ],
    modelAvailability: 'key',
    inferenceAdapterId: 'dashscope-inference-adapter',
    usageAdapterId: REACTIVE_ONLY_USAGE_ADAPTER_ID,
    brand: { domain: 'alibabacloudmail.com', accentColor: '#FF6A00' },
  },
  inferenceAdapter: (options) => createDashscopeInferenceAdapter(options),
  usageAdapter: () => createGenericUsageAdapter(),
}
