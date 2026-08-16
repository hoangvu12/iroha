/**
 * Inference Adapters: typed knowledge of how to speak a Provider Connection's
 * inference API. The generic form forwards OpenAI-compatible requests and
 * responses unchanged and owns safe authentication injection.
 */
export type {
  AnthropicForwardRequest,
  InferenceAdapter,
  InferenceAdapterCapabilities,
  InferenceFailureCapacityScope,
  InferenceFailureClassification,
  InferenceFailureContext,
  InferenceFailureKind,
  InferenceFailureRetryAction,
  InferenceForwardRequest,
  InferenceForwardResult,
} from './adapter.ts'
export {
  callerSuppliedIdempotency,
  createGenericInferenceAdapter,
  generateIdempotencyValue,
  upstreamUrl,
  type GenericInferenceAdapterOptions,
} from './generic-adapter.ts'
export {
  DEFAULT_ANTHROPIC_MAX_TOKENS,
  DEFAULT_ANTHROPIC_VERSION,
  createAnthropicInferenceAdapter,
  getMaxTokensForModel,
  type AnthropicForwardError,
  type AnthropicInferenceAdapterOptions,
} from './anthropic-adapter.ts'
export { createDashscopeInferenceAdapter } from './dashscope-adapter.ts'
export { createMinimaxInferenceAdapter } from './minimax-adapter.ts'
