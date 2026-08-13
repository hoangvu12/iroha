/**
 * Provider Templates: built-in data-only setup aids.
 *
 * A Provider Template is **never an account or a secret**. It is the known-good
 * defaults for one Provider — the canonical base URL, the canonical
 * authentication header shape, the capability defaults, the model list the
 * template was reviewed against — that the Owner uses to seed a new
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

import type { ConnectionCapabilities } from '../persistence/index.ts'

/**
 * The well-known Inference Adapter id the generic Inference Adapter is
 * registered under. Built-in templates reference it; the Adapter Registry
 * asserts it exists at startup.
 */
export const GENERIC_INFERENCE_ADAPTER_ID = 'generic-inference-adapter'

/**
 * The well-known Usage Adapter id the reactive-only generic Usage Adapter is
 * registered under. Built-in templates that have no documented entitlement
 * API point at it; the Adapter Registry asserts it exists at startup.
 */
export const REACTIVE_ONLY_USAGE_ADAPTER_ID = 'reactive-only-usage-adapter'

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
  readonly capabilities: ConnectionCapabilities
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
}

/**
 * The built-in Provider Templates Iroha ships with. Order is the order the
 * Owner sees in the picker; the generic default comes first so the Owner is
 * never nudged toward a brand when a compatible service will do.
 */
export const BUILT_IN_PROVIDER_TEMPLATES: readonly ProviderTemplate[] = [
  {
    id: 'generic-openai-compatible',
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
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    description:
      'OpenAI\u2019s public OpenAI-compatible surface. Bearer authentication and the full capability set Iroha knows OpenAI supports.',
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
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    description:
      'OpenRouter\u2019s OpenAI-compatible surface. Bearer authentication; the catalog merges whatever OpenRouter reports on refresh.',
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
  },
  {
    id: 'MiniMax',
    displayName: 'MiniMax',
    description:
      'MiniMax\u2019s OpenAI-compatible endpoint. Bearer authentication; supports chat completions, streaming, tools, and the OpenAI Responses API.',
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
    inferenceAdapterId: GENERIC_INFERENCE_ADAPTER_ID,
    usageAdapterId: REACTIVE_ONLY_USAGE_ADAPTER_ID,
  },
]

/** Looks one template up by id. Returns null when the id is unknown. */
export function findBuiltInTemplate(id: string): ProviderTemplate | null {
  return BUILT_IN_PROVIDER_TEMPLATES.find((template) => template.id === id) ?? null
}