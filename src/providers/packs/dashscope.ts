/**
 * DashScope Provider Pack: Alibaba Cloud's international OpenAI-compatible
 * endpoint. Bearer authentication over the OpenAI wire shape, a typed inference
 * adapter with bounded recovery from intermittent content-inspection failures,
 * and reactive-only entitlement visibility.
 */

import { createDashscopeInferenceAdapter } from '../../inference/dashscope-adapter.ts'
import { createGenericUsageAdapter } from '../../usage/generic-adapter.ts'
import {
  DASHSCOPE_INFERENCE_ADAPTER_ID,
  REACTIVE_ONLY_USAGE_ADAPTER_ID,
} from '../adapter-ids.ts'
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
    knownModels: [
      'qwen3-coder-next',
      'qwen3-coder-plus',
      'qwen3-max-2026-01-23',
      'qwen3.5-plus',
      'qwen3.6-plus',
      'qwen3.7-plus',
    ],
    inferenceAdapterId: DASHSCOPE_INFERENCE_ADAPTER_ID,
    usageAdapterId: REACTIVE_ONLY_USAGE_ADAPTER_ID,
    brand: { domain: 'alibabacloudmail.com', accentColor: '#FF6A00' },
  },
  inferenceAdapter: (options) => createDashscopeInferenceAdapter(options),
  usageAdapter: () => createGenericUsageAdapter(),
}
