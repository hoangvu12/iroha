/**
 * Gateway Keys: the credentials applications present to Iroha, their Key
 * Scope over Provider Connections and models, and the authenticated Provider
 * Directory that discovery is filtered through.
 */
export {
  GatewayKeyRegistry,
  type CreatedGatewayKey,
  type DirectoryProvider,
  type DiscoveryResult,
  type FieldProblem,
  type GatewayKeyFailure,
  type GatewayKeyRegistryOptions,
  type GatewayKeyResult,
  type GatewayKeyView,
  type InferenceAuthorization,
} from './gateway-key-registry.ts'
