/**
 * Provider Templates: built-in data-only setup aids.
 *
 * A Provider Template is **never an account or a secret**. It is the known-good
 * defaults for one Provider —€” the canonical base URL, the canonical
 * authentication header shape, the capability defaults, the model list the
 * template was reviewed against —€” that the Owner uses to seed a new
 * Provider Connection. The Owner always supplies their own Upstream Key,
 * display name, and any deviation from the defaults they need; the template
 * makes routine setup quick without ever sending a credential through Iroha's
 * release process.
 *
 * Templates live as data so an unusual Provider Connection can still go
 * through the generic path (no template at all) without losing any default.
 * Every built-in template points at the generic Inference Adapter; a typed
 * adapter is only added when a Provider genuinely needs behavior the generic
 * cannot give. The same is true of Usage Adapters: only Providers with a
 * documented entitlement API get a typed adapter; everyone else is honest
 * reactive-only.
 */

import type { ProviderCapabilities } from '../persistence/index.ts'

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

/**
 * The id of the Generic OpenAI-compatible Provider Template, the default Iroha
 * seeds a new Provider Connection with when the Owner names no template. It
 * carries no brand and no inferred capability defaults, so a bare create stays
 * honest: safe OpenAI-shaped defaults, nothing assumed.
 */
export const GENERIC_PROVIDER_TEMPLATE_ID = 'generic-openai-compatible'

/**
 * The brand identity of a Provider Template: the upstream domain logo.dev
 * resolves for the tile, and the accent colour the management UI tints the
 * tile with. Both fields belong on the template because every brand decision
 * for one Provider should live in one file; a brand split across CSS vars,
 * inline SVGs, and string-matching heuristics falls apart the moment a fifth
 * Provider is added.
 *
 * Omitted (or null) for templates that name no upstream brand (for example
 * the generic default). The UI renders a generic server icon and the brand
 * logo route returns 404 in that case.
 */
export interface ProviderTemplateBrand {
  /** The hostname logo.dev should resolve to (for example "openai.com"). */
  readonly domain: string
  /** CSS hex; tinted onto the brand tile in both light and dark modes. */
  readonly accentColor: string
}

/**
 * The fields a template may prefill on a new Provider Connection. The Owner
 * may override every one of them; the template only seeds sensible defaults.
 *
 * `baseUrl` is the canonical Provider endpoint. Templates never store
 * accounts, secrets, headers that carry a key, or any per-tenant URL.
 *
 * `capabilities` is the default capability claim the connection starts with.
 * The Owner can later override any of them per model.
 *
 * `knownModels` is the model list the template was reviewed against. Discovery
 * still runs on creation and on Owner-visible triggers; the template's list
 * fills gaps when discovery returns less or before it has run.
 *
 * `inferenceAdapterId` and `usageAdapterId` are the registered adapters the
 * template assumes; the registry rejects a template that names a missing one.
 *
 * `brand` is the visual identity the management UI uses for this template.
 * Omitted for templates that name no upstream brand.
 */
export interface ProviderTemplate {
  readonly id: string
  /** A short Owner-facing label shown in the connection picker. */
  readonly displayName: string
  /** A short description shown alongside the label. Never carries a URL with credentials. */
  readonly description: string
  /** The default base URL the connection starts at; the Owner can override. */
  readonly baseUrl: string
  /** Canonical authentication header name (e.g. "Authorization", "X-Api-Key"). */
  readonly authHeader: string
  /** Plain-text prefix for the authentication header; "" means none. */
  readonly authPrefix: string
  /** Default capability claim; the Owner can override any field per model. */
  readonly capabilities: ProviderCapabilities
  /** Models the template was reviewed against; data-only, never a secret. */
  readonly knownModels: readonly string[]
  /** The registered Inference Adapter the template assumes. */
  readonly inferenceAdapterId: string
  /**
   * The registered Usage Adapter the template assumes. When null, the template
   * has no documented entitlement endpoint and the reactive-only generic one
   * is honest by default.
   */
  readonly usageAdapterId: string | null
  /** The brand identity rendered in the management UI. Null when the template has no upstream brand. */
  readonly brand: ProviderTemplateBrand | null
}

/**
 * The built-in Provider Templates Iroha ships with. Order is the order the
 * Owner sees in the picker; the generic default comes first so the Owner is
 * never nudged toward a brand when a compatible service will do.
 */
export const BUILT_IN_PROVIDER_TEMPLATES: readonly ProviderTemplate[] = [
  {
    id: GENERIC_PROVIDER_TEMPLATE_ID,
    displayName: 'Generic OpenAI-compatible',
    description:
      'A safe default for any OpenAI-shaped service Iroha does not know by brand. Bearer authentication, no inferred capability defaults, and reactive-only entitlement visibility.',
    baseUrl: 'https://api.example.com/v1',
    authHeader: 'authorization',
    authPrefix: 'Bearer ',
    capabilities: {
      chat: false,
      streaming: false,
      tools: false,
      structuredOutput: false,
      responses: false,
    },
    knownModels: [],
    inferenceAdapterId: GENERIC_INFERENCE_ADAPTER_ID,
    usageAdapterId: REACTIVE_ONLY_USAGE_ADAPTER_ID,
    brand: null,
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    description:
      'OpenAI’s public OpenAI-compatible surface. Bearer authentication and the full capability set Iroha knows OpenAI supports.',
    baseUrl: 'https://api.openai.com/v1',
    authHeader: 'authorization',
    authPrefix: 'Bearer ',
    capabilities: {
      chat: true,
      streaming: true,
      tools: true,
      structuredOutput: true,
      responses: true,
    },
    knownModels: [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4.1-nano',
      'o1',
      'o1-mini',
      'o3',
      'o3-mini',
      'o4-mini',
    ],
    inferenceAdapterId: GENERIC_INFERENCE_ADAPTER_ID,
    usageAdapterId: REACTIVE_ONLY_USAGE_ADAPTER_ID,
    brand: { domain: 'openai.com', accentColor: '#10A37F' },
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    description:
      'OpenRouter’s OpenAI-compatible surface. Bearer authentication; the catalog merges whatever OpenRouter reports on refresh.',
    baseUrl: 'https://openrouter.ai/api/v1',
    authHeader: 'authorization',
    authPrefix: 'Bearer ',
    capabilities: {
      chat: true,
      streaming: true,
      tools: true,
      structuredOutput: true,
      responses: false,
    },
    knownModels: [],
    inferenceAdapterId: GENERIC_INFERENCE_ADAPTER_ID,
    usageAdapterId: REACTIVE_ONLY_USAGE_ADAPTER_ID,
    brand: { domain: 'openrouter.ai', accentColor: '#3D55E6' },
  },
  {
    id: 'dashscope',
    displayName: 'DashScope',
    description:
      'Alibaba Cloud DashScope international OpenAI-compatible endpoint with bounded recovery from intermittent content-inspection failures.',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    authHeader: 'authorization',
    authPrefix: 'Bearer ',
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
    brand: { domain: 'aliyun.com', accentColor: '#FF6A00' },
  },
  {
    id: 'MiniMax',
    displayName: 'MiniMax',
    description:
      'MiniMax’s OpenAI-compatible endpoint. Bearer authentication; supports chat completions, streaming, tools, and the OpenAI Responses API. Entitlement polls chain the MiniMax coding-plan and credit endpoints.',
    baseUrl: 'https://api.minimax.io/v1',
    authHeader: 'authorization',
    authPrefix: 'Bearer ',
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
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    description:
      'Anthropic’s first-party API. Authentication uses the `x-api-key` header; the typed Anthropic Inference Adapter translates OpenAI-shape requests and responses to and from the Anthropic Messages envelope.',
    baseUrl: 'https://api.anthropic.com/v1',
    authHeader: 'x-api-key',
    authPrefix: '',
    capabilities: {
      chat: true,
      streaming: true,
      tools: true,
      structuredOutput: true,
      responses: true,
    },
    knownModels: [
      'anthropic-opus-5',
      'anthropic-sonnet-5',
      'anthropic-fable-5',
      'anthropic-mythos-5',
      'anthropic-opus-4-8',
      'anthropic-opus-4-7',
      'anthropic-mythos-preview',
      'anthropic-opus-4-6',
      'anthropic-sonnet-4-6',
      'anthropic-haiku-4-5',
      'anthropic-haiku-4-5-20251001',
      'anthropic-opus-4-5',
      'anthropic-opus-4-5-20251101',
      'anthropic-sonnet-4-5',
      'anthropic-sonnet-4-5-20250929',
    ],
    inferenceAdapterId: ANTHROPIC_INFERENCE_ADAPTER_ID,
    usageAdapterId: REACTIVE_ONLY_USAGE_ADAPTER_ID,
    brand: { domain: 'anthropic.com', accentColor: '#D97757' },
  },
]

/** Looks one template up by id. Returns null when the id is unknown. */
export function findBuiltInTemplate(id: string): ProviderTemplate | null {
  return BUILT_IN_PROVIDER_TEMPLATES.find((template) => template.id === id) ?? null
}
