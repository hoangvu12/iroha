/**
 * DeepAI Code Provider Pack: the DeepAI Code brand reached through a
 * deepai-proxy gateway.
 *
 * The gateway speaks the OpenAI wire shape and owns the DeepAI Code protocol
 * upstream, so the Inference Adapter is the generic one. The Usage Adapter is
 * typed: a gateway answers `GET /theos` with the Theos allowance of the
 * credential the caller presents, which is authoritative per Upstream Key and
 * lets Iroha retire a key whose daily Theos ran out.
 */

import { createGenericInferenceAdapter } from '../../inference/generic-adapter.ts'
import { createDeepaiUsageAdapter } from '../../usage/deepai-usage-adapter.ts'
import { GENERIC_INFERENCE_ADAPTER_ID } from '../adapter-ids.ts'
import type { ProviderPack } from './pack.ts'

export const deepaiPack: ProviderPack = {
  id: 'deepai-code',
  template: {
    displayName: 'DeepAI Code',
    description:
      'DeepAI Code through a deepai-proxy gateway. Point the base URL at your own gateway (…/v1): it speaks the OpenAI wire shape, owns the DeepAI Code protocol upstream, and reports each key’s Theos allowance. One key per DeepAI account, so the daily grant of each account is its own.',
    baseUrl: 'https://api.deepai.org/v1',
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
      'glm-5.3-flash',
      'deepseek-v4.1-flash',
      'mimo-2.6-flash',
      'qwen-3.8-flash',
      'minimax-m3.1-flash',
      'muse-ember',
      'solar-mini-4',
      'gpt-6-luna',
      'mimo-2.6-pro',
      'glyph-cluster',
      'deepai-cyber',
      'minimax-m3',
      'gpt-6.1-sol',
      'gemini-4-argon',
      'glm-5.3',
      'kimi-k3',
      'kimi-k3.1-pro',
      'gpt-6.1-terra',
      'muse-spark-1.3',
      'gemini-4-hydrogen',
      'gemini-4-carbon',
      'claude-sonnet-5-5',
      'claude-opus-5-5',
      'muse-wonder',
      'qwen-3.8-max-prime',
      'claude-fable-5-2',
      'gpt-6.astra',
    ],
    modelAvailability: 'key',
    modelDiscovery: 'supported',
    inferenceAdapterId: GENERIC_INFERENCE_ADAPTER_ID,
    usageAdapterId: 'deepai-usage-adapter',
    brand: { domain: 'deepai.org', accentColor: '#7C3AED' },
  },
  inferenceAdapter: (options) => createGenericInferenceAdapter(options),
  usageAdapter: (options) => createDeepaiUsageAdapter(options),
}
