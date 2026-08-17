/**
 * MiniMax Provider Pack: pairs the MiniMax template with its typed inference and
 * usage adapters. OpenAI wire shape, Bearer authentication, and entitlement
 * polls that chain the MiniMax coding-plan and credit endpoints.
 */

import { createMinimaxInferenceAdapter } from '../../inference/minimax-adapter.ts'
import { createMinimaxUsageAdapter } from '../../usage/minimax-usage-adapter.ts'
import {
  MINIMAX_INFERENCE_ADAPTER_ID,
  MINIMAX_USAGE_ADAPTER_ID,
} from '../adapter-ids.ts'
import type { ProviderPack } from './pack.ts'

export const minimaxPack: ProviderPack = {
  id: 'MiniMax',
  template: {
    displayName: 'MiniMax',
    description:
      'MiniMax’s OpenAI-compatible endpoint. Bearer authentication; supports chat completions, streaming, tools, and the OpenAI Responses API. Entitlement polls chain the MiniMax coding-plan and credit endpoints.',
    baseUrl: 'https://api.minimax.io/v1',
    authHeader: 'authorization',
    authPrefix: 'Bearer ',
    wireFormat: 'openai',
    capabilities: {
      chat: true,
      streaming: true,
      tools: true,
      structuredOutput: false,
      responses: true,
    },
    knownModels: [
      'MiniMax-M3',
      'MiniMax-M2.7',
      'MiniMax-M2.7-highspeed',
      'MiniMax-M2.5',
      'MiniMax-M2.5-highspeed',
      'MiniMax-M2.1',
      'MiniMax-M2.1-highspeed',
      'MiniMax-M2',
    ],
    inferenceAdapterId: MINIMAX_INFERENCE_ADAPTER_ID,
    usageAdapterId: MINIMAX_USAGE_ADAPTER_ID,
    brand: { domain: 'minimax.io', accentColor: '#F43F5E' },
  },
  inferenceAdapter: (options) => createMinimaxInferenceAdapter(options),
  usageAdapter: (options) => createMinimaxUsageAdapter(options),
}
