/**
 * Well-known adapter and template id constants.
 *
 * These live in a dependency-free leaf module so a Provider Pack can name the
 * id it carries without importing the Provider Template list — the list is
 * derived from the Packs, so a Pack that reached back through `templates.ts`
 * for its id would close an import cycle. `templates.ts` re-exports each
 * constant here, so existing importers are unchanged.
 *
 * Only the two ids that survive the move to Provider Packs remain: a Pack
 * references its adapter factories directly and inlines the id it labels them
 * with, so the typed adapter-id constants are gone. The generic Inference
 * Adapter id is still the Adapter Registry's default when a Provider has no
 * template, and the reactive-only Usage Adapter id is the honest default a
 * template names when it has no entitlement endpoint.
 */

/**
 * The well-known Inference Adapter id the generic Inference Adapter is
 * registered under. A Provider with no template resolves to it.
 */
export const GENERIC_INFERENCE_ADAPTER_ID = 'generic-inference-adapter'

/**
 * The well-known Usage Adapter id the reactive-only generic Usage Adapter is
 * registered under. Built-in templates that have no documented entitlement API
 * point at it.
 */
export const REACTIVE_ONLY_USAGE_ADAPTER_ID = 'reactive-only-usage-adapter'

/**
 * The id of the Generic OpenAI-compatible Provider Template, the default Iroha
 * seeds a new Provider Connection with when the Owner names no template. It
 * carries no brand and no inferred capability defaults, so a bare create stays
 * honest: safe OpenAI-shaped defaults, nothing assumed.
 */
export const GENERIC_PROVIDER_TEMPLATE_ID = 'generic-openai-compatible'
