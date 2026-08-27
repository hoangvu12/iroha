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
 *
 * The built-in templates themselves are no longer declared here: each belongs
 * to a Provider Pack under `packs/`, and the built-in list is derived from the
 * Pack list (ADR-0019). This module keeps the Provider Template type and
 * re-exports the derived list so existing importers are unchanged.
 */

import type { ProviderCapabilities } from '../persistence/index.ts'

/**
 * The body shape a Provider's upstream speaks on the inference wire: either the
 * OpenAI Chat Completions shape or the Anthropic Messages shape.
 *
 * This is Provider Template data, read at request time by the Anthropic
 * messages surface to decide whether a caller's Anthropic-shape body passes
 * through unchanged (`anthropic`) or is translated to the OpenAI shape and the
 * answer translated back (`openai`). It is **not** persisted per Provider — a
 * Provider with no Provider Template is treated as the OpenAI shape — and it is
 * **not** an Inference Adapter capability. Per ADR-0020 the wire shape
 * describes the upstream a Provider points at, not a capability of the adapter
 * translating for it, so ADR-0010 stands and no adapter must declare which
 * caller shapes it accepts.
 */
export type ProviderWireFormat = 'openai' | 'anthropic'

// The adapter and template id constants live in a dependency-free leaf module
// so a Provider Pack can name the id it carries without closing an import cycle
// back through this file. They are re-exported here so existing importers of
// `templates.ts` are unchanged.
export {
  GENERIC_INFERENCE_ADAPTER_ID,
  REACTIVE_ONLY_USAGE_ADAPTER_ID,
  GENERIC_PROVIDER_TEMPLATE_ID,
} from './adapter-ids.ts'

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
  /**
   * The body shape this template's upstream speaks on the inference wire. Read
   * at request time by the Anthropic messages surface to choose passthrough
   * (`anthropic`) over translation (`openai`); Provider Template data, never
   * persisted per Provider and never an Inference Adapter capability. See
   * ADR-0020.
   *
   * Optional so a Provider Template that names no upstream shape — and any
   * caller that omits it — is read as the OpenAI shape, the safe default for a
   * service Iroha does not know by brand. Every built-in declares it
   * explicitly.
   */
  readonly wireFormat?: ProviderWireFormat
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
  /**
   * Whether the Provider exposes the OpenAI-compatible `GET /models` surface.
   * `unsupported` makes refresh reconcile the reviewed template knowledge
   * without issuing a request the Provider does not implement.
   */
  readonly modelDiscovery?: 'supported' | 'best_effort' | 'unsupported'
  /**
   * Whether this upstream offers the same Upstream Models to every Upstream Key
   * of a Provider (`provider`) or a different set per key (`key`).
   *
   * Only `key` gives a Provider's keys a meaningful Key Model Availability:
   * Iroha then discovers each key's models separately, unions them into the
   * Model Catalog, and prefers the keys known to carry a requested model when
   * it selects one. Optional, and read as `provider` when omitted, because that
   * is what almost every upstream does and what Iroha did before this existed.
   */
  readonly modelAvailability?: 'provider' | 'key'
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

// The built-in Provider Templates are derived from the built-in Provider Pack
// list (ADR-0019) and re-exported here so existing importers are unchanged.
export { BUILT_IN_PROVIDER_TEMPLATES, findBuiltInTemplate } from './packs/index.ts'
