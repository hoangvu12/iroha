/**
 * Providers: how the Owner configures the upstream services the Gateway
 * reaches, and the Upstream Keys attached to them.
 */
export {
  AdapterRegistry,
  AdapterRegistryValidationError,
  createBuiltInAdapterRegistry,
  inferenceAdapters,
  usageAdapters,
  type AdapterRegistryOptions,
} from './adapter-registry.ts'
export {
  ProviderRegistry,
  type FieldProblem,
  type InferenceTarget,
  type KeyView,
  type ProviderFailure,
  type ProviderRegistryOptions,
  type ProviderResult,
  type ProviderView,
  type UpstreamAccountView,
} from './provider-registry.ts'
export { RoundRobinSelector } from './round-robin.ts'
export {
  createGenericKeyProbe,
  type KeyProbeOptions,
  type KeyProbeRequest,
  type KeyProbeResult,
  type UpstreamKeyProbe,
} from './key-probe.ts'
export {
  BUILT_IN_PROVIDER_TEMPLATES,
  findBuiltInTemplate,
  GENERIC_INFERENCE_ADAPTER_ID,
  MINIMAX_USAGE_ADAPTER_ID,
  REACTIVE_ONLY_USAGE_ADAPTER_ID,
  type ProviderTemplate,
} from './templates.ts'
