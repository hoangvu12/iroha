/**
 * Adapter and template id constants.
 *
 * These live in a dependency-free leaf module so a Provider Pack can name the
 * id it carries without importing the Provider Template list — the list is
 * derived from the Packs, so a Pack that reached back through `templates.ts`
 * for its id would close an import cycle. `templates.ts` re-exports every
 * constant here, so existing importers are unchanged.
 *
 * The adapter-id constants are transitional: a Provider Pack references its
 * adapter factories directly, so once nothing looks an adapter up by string
 * these constants are removed (ticket 06).
 */

/**
 * The well-known Inference Adapter id the generic Inference Adapter is
 * registered under. Built-in templates reference it; the Adapter Registry
 * asserts it exists at startup.
 */
export const GENERIC_INFERENCE_ADAPTER_ID = 'generic-inference-adapter'

/**
 * The well-known Inference Adapter id the typed Anthropic Inference Adapter
 * is registered under. The `anthropic` Provider Template references it;
 * the Adapter Registry asserts it exists at startup.
 */
export const ANTHROPIC_INFERENCE_ADAPTER_ID = 'anthropic-inference-adapter'

/** Typed DashScope adapter for provider-specific content-inspection retries. */
export const DASHSCOPE_INFERENCE_ADAPTER_ID = 'dashscope-inference-adapter'

/** Typed MiniMax adapter for structured text-capacity failure evidence. */
export const MINIMAX_INFERENCE_ADAPTER_ID = 'minimax-inference-adapter'

/** Typed Z.ai (Zhipu / BigModel) adapter for documented error-code capacity evidence. */
export const ZAI_INFERENCE_ADAPTER_ID = 'zai-inference-adapter'

/**
 * The well-known Usage Adapter id the reactive-only generic Usage Adapter is
 * registered under. Built-in templates that have no documented entitlement
 * API point at it; the Adapter Registry asserts it exists at startup.
 */
export const REACTIVE_ONLY_USAGE_ADAPTER_ID = 'reactive-only-usage-adapter'

/**
 * The well-known Usage Adapter id the MiniMax typed Usage Adapter is
 * registered under. The MiniMax Provider Template points at it because
 * MiniMax exposes a documented entitlement API at
 * `/v1/api/openplatform/coding_plan/remains` and `/account/query_balance`
 * reachable with the same bearer key as inference.
 */
export const MINIMAX_USAGE_ADAPTER_ID = 'minimax-usage-adapter'

/** Authoritative GLM Coding Plan quota adapter shared by Z.ai and BigModel. */
export const ZAI_USAGE_ADAPTER_ID = 'zai-usage-adapter'

/**
 * The id of the Generic OpenAI-compatible Provider Template, the default Iroha
 * seeds a new Provider Connection with when the Owner names no template. It
 * carries no brand and no inferred capability defaults, so a bare create stays
 * honest: safe OpenAI-shaped defaults, nothing assumed.
 */
export const GENERIC_PROVIDER_TEMPLATE_ID = 'generic-openai-compatible'
