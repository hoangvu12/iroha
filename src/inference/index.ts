/**
 * Inference Adapters: typed knowledge of how to speak a Provider Connection's
 * inference API. The generic form forwards OpenAI-compatible requests and
 * responses unchanged and owns safe authentication injection.
 */
export type { InferenceAdapter, InferenceForwardRequest, InferenceForwardResult } from './adapter.ts'
export {
  createGenericInferenceAdapter,
  upstreamUrl,
  type GenericInferenceAdapterOptions,
} from './generic-adapter.ts'
