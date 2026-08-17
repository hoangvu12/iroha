import type { InferenceAdapter } from '../inference/index.ts'
import type { UsageAdapter } from '../usage/index.ts'
import {
  BUILT_IN_PROVIDER_TEMPLATES,
  GENERIC_INFERENCE_ADAPTER_ID,
  type ProviderTemplate,
  type ProviderWireFormat,
} from './templates.ts'
import { BUILT_IN_PROVIDER_PACKS, type PackAdapterOptions, type ProviderPack } from './packs/index.ts'

/**
 * The Adapter Registry: the single source of truth for which Inference and
 * Usage Adapters Iroha has, and which Provider Templates are available.
 *
 * Built-in adapters and templates ship as data so the generic path is always
 * covered. Typed adapters — the only thing a future Provider-specific
 * release would add — register themselves the same way. The registry
 * validates everything at construction time: duplicate IDs are rejected with
 * a structural error, and any template that names a missing adapter is
 * rejected with the same kind of error. A misconfigured runtime therefore
 * never gets as far as the first request.
 */
export interface AdapterRegistryOptions {
  /**
   * Built-in or third-party inference adapters keyed by id. The id is what a
   * Provider Template references; collisions are rejected at construction.
   *
   * Accepted as a list of [id, adapter] entries so a misconfigured factory
   * can carry a literal duplicate through to the validator: a `Record`
   * collapses duplicates before construction reaches the registry, hiding
   * the very problem this validator exists to catch.
   */
  readonly inferenceAdapters: ReadonlyArray<readonly [string, InferenceAdapter]>
  /**
   * Built-in or third-party usage adapters keyed by id. The id is what a
   * Provider Template references; collisions are rejected at construction.
   *
   * Accepted as a list of [id, adapter] entries for the same reason as
   * {@link AdapterRegistryOptions.inferenceAdapters}.
   */
  readonly usageAdapters: ReadonlyArray<readonly [string, UsageAdapter]>
  /**
   * Provider Templates that this Iroha build ships with. Defaults to the
   * built-in set when omitted; tests and future builds can supply their own.
   */
  readonly providerTemplates?: readonly ProviderTemplate[]
}

/**
 * Builds an inference adapter map for the common case where duplicates are
 * impossible — tests and production callers wrap their declarations in this
 * helper, the registry internally iterates over [id, adapter] entries so it
 * can detect duplicates the Record type would otherwise hide.
 */
export function inferenceAdapters(
  entries: Readonly<Record<string, InferenceAdapter>>,
): ReadonlyArray<readonly [string, InferenceAdapter]> {
  return Object.entries(entries)
}

/**
 * Builds a usage adapter map for the common case where duplicates are
 * impossible — tests and production callers wrap their declarations in this
 * helper, the registry internally iterates over [id, adapter] entries so it
 * can detect duplicates the Record type would otherwise hide.
 */
export function usageAdapters(
  entries: Readonly<Record<string, UsageAdapter>>,
): ReadonlyArray<readonly [string, UsageAdapter]> {
  return Object.entries(entries)
}

/**
 * Raised when the Adapter Registry is asked to construct itself with
 * duplicate adapter IDs, duplicate template IDs, a template that names an
 * unknown adapter, or any other malformed declaration. The message lists
 * every problem so an operator never has to fix one error and re-run to
 * find the next.
 */
export class AdapterRegistryValidationError extends Error {
  readonly #problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(
      `Adapter registry is malformed:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`,
    )
    this.name = 'AdapterRegistryValidationError'
    this.#problems = problems
  }

  /** Every structural problem the registry caught, in declaration order. */
  get problems(): readonly string[] {
    return this.#problems
  }
}

/**
 * The Adapter Registry: holds the maps and validates them once, up front.
 * It is read-only after construction; runtime callers reach for an adapter
 * by id through `inferenceAdapter` or `usageAdapter`, and reach a template
 * by id through `providerTemplate`.
 */
export class AdapterRegistry {
  readonly #inference: ReadonlyMap<string, InferenceAdapter>
  readonly #usage: ReadonlyMap<string, UsageAdapter>
  readonly #templates: ReadonlyMap<string, ProviderTemplate>
  /** Stable display order for the Owner-facing template picker. */
  readonly #templateOrder: readonly string[]

  constructor(options: AdapterRegistryOptions) {
    const inference = new Map<string, InferenceAdapter>()
    const usage = new Map<string, UsageAdapter>()
    const templates = options.providerTemplates ?? BUILT_IN_PROVIDER_TEMPLATES
    const problems: string[] = []

    for (const [id, adapter] of options.inferenceAdapters) {
      if (id === '' || /\s/.test(id)) {
        problems.push(`inference adapter id ${JSON.stringify(id)} is blank or contains whitespace`)
        continue
      }
      if (inference.has(id)) {
        problems.push(`duplicate inference adapter id ${JSON.stringify(id)}`)
        continue
      }
      inference.set(id, adapter)
    }

    for (const [id, adapter] of options.usageAdapters) {
      if (id === '' || /\s/.test(id)) {
        problems.push(`usage adapter id ${JSON.stringify(id)} is blank or contains whitespace`)
        continue
      }
      if (usage.has(id)) {
        problems.push(`duplicate usage adapter id ${JSON.stringify(id)}`)
        continue
      }
      usage.set(id, adapter)
    }

    const templateOrder: string[] = []
    const templateMap = new Map<string, ProviderTemplate>()
    for (const template of templates) {
      if (template.id === '' || /\s/.test(template.id)) {
        problems.push(`provider template id ${JSON.stringify(template.id)} is blank or contains whitespace`)
        continue
      }
      if (templateMap.has(template.id)) {
        problems.push(`duplicate provider template id ${JSON.stringify(template.id)}`)
        continue
      }
      if (!inference.has(template.inferenceAdapterId)) {
        problems.push(
          `provider template ${JSON.stringify(template.id)} names unknown inference adapter ${JSON.stringify(template.inferenceAdapterId)}`,
        )
        continue
      }
      if (template.usageAdapterId !== null && !usage.has(template.usageAdapterId)) {
        problems.push(
          `provider template ${JSON.stringify(template.id)} names unknown usage adapter ${JSON.stringify(template.usageAdapterId)}`,
        )
        continue
      }
      templateMap.set(template.id, template)
      templateOrder.push(template.id)
    }

    if (problems.length > 0) {
      throw new AdapterRegistryValidationError(problems)
    }

    this.#inference = inference
    this.#usage = usage
    this.#templates = templateMap
    this.#templateOrder = templateOrder
  }

  /** The inference adapter with this id, or null when no such adapter is registered. */
  inferenceAdapter(id: string): InferenceAdapter | null {
    return this.#inference.get(id) ?? null
  }

  /** The usage adapter with this id, or null when no such adapter is registered. */
  usageAdapter(id: string): UsageAdapter | null {
    return this.#usage.get(id) ?? null
  }

  /** The provider template with this id, or null when no such template exists. */
  providerTemplate(id: string): ProviderTemplate | null {
    return this.#templates.get(id) ?? null
  }

  /**
   * The wire shape the Provider Template with this id declares — the body
   * shape its upstream speaks. A Provider with no template, or one whose
   * template is unknown, is read as the OpenAI shape, the safe default. This
   * is the single place the templateId-to-wire-shape decision is made, so the
   * inference and entitlement paths cannot disagree about it.
   */
  resolveWireFormat(templateId: string | null): ProviderWireFormat {
    if (templateId === null) return 'openai'
    return this.#templates.get(templateId)?.wireFormat ?? 'openai'
  }

  /**
   * The Inference Adapter a Provider with this template id should use. A
   * Provider with no template, an unknown template, or a template whose named
   * adapter is missing resolves to the generic Inference Adapter — the same
   * defaulting the route-local resolver used before, now in one place so two
   * callers can never disagree about which adapter a Provider uses.
   */
  resolveInferenceAdapter(templateId: string | null): InferenceAdapter | null {
    const generic = this.#inference.get(GENERIC_INFERENCE_ADAPTER_ID) ?? null
    if (templateId === null) return generic
    const template = this.#templates.get(templateId)
    if (template === undefined) return generic
    return this.#inference.get(template.inferenceAdapterId) ?? generic
  }

  /**
   * The typed Usage Adapter a Provider with this template id names, or null
   * when the template is absent, unknown, names no Usage Adapter, or names one
   * that is not registered. The entitlement polling path pairs this with its
   * own honest reactive-only default, so the reading never claims an authority
   * the template did not promise.
   */
  typedUsageAdapter(templateId: string | null): UsageAdapter | null {
    if (templateId === null) return null
    const template = this.#templates.get(templateId)
    if (template === undefined || template.usageAdapterId === null) return null
    return this.#usage.get(template.usageAdapterId) ?? null
  }

  /**
   * The provider templates Iroha currently offers, in the order the Owner
   * sees them. The list is what the management UI renders in the template
   * picker.
   */
  listProviderTemplates(): readonly ProviderTemplate[] {
    const out: ProviderTemplate[] = []
    for (const id of this.#templateOrder) {
      const template = this.#templates.get(id)
      if (template !== undefined) out.push(template)
    }
    return out
  }

  /**
   * The Inference Adapter that translates for the Anthropic messages surface —
   * the one able to speak the Anthropic Messages shape (its `forwardAnthropic`
   * is defined). The `/v1/messages` route uses it as its translator regardless
   * of which Provider it is serving, so it is selected by that capability
   * rather than by a brand string or adapter id. Null when this build ships no
   * such adapter.
   */
  anthropicMessagesTranslator(): InferenceAdapter | null {
    for (const adapter of this.#inference.values()) {
      if (adapter.forwardAnthropic !== undefined) return adapter
    }
    return null
  }
}

/**
 * The optional inputs to {@link createBuiltInAdapterRegistry} for tests and
 * future builds. Every field defaults to production-correct behaviour; an
 * option exists for the seam only when a caller genuinely needs to swap the
 * value (most often to inject the test's mock upstream transport into every
 * built-in Inference Adapter).
 */
export interface BuiltInAdapterRegistryOptions {
  /**
   * When set, every built-in Provider Pack's Inference and Usage Adapter is
   * constructed over this upstream transport. This is the one mechanism the
   * test harness uses so no Provider can silently escape to the real network,
   * and it is the only seam this factory offers — adding a Pack can never
   * require a new option here.
   */
  readonly upstreamTransport?: typeof fetch
}

/**
 * Builds an Adapter Registry from a Provider Pack list: each Pack's Inference
 * and Usage Adapter is constructed from the Pack's own factory, so the Pack —
 * not a string id — is what carries a Provider's behaviour. Adapters shared by
 * several Packs (the generic Inference Adapter, the reactive-only Usage
 * Adapter) are built once and keyed by the id the Packs name them under. The
 * optional adapter options — only an injectable upstream transport — are
 * applied to every Pack uniformly.
 */
export function adapterRegistryFromPacks(
  packs: readonly ProviderPack[],
  adapterOptions: PackAdapterOptions = {},
): AdapterRegistry {
  const inferenceSeen = new Map<string, InferenceAdapter>()
  const usageSeen = new Map<string, UsageAdapter>()
  const inferenceEntries: (readonly [string, InferenceAdapter])[] = []
  const usageEntries: (readonly [string, UsageAdapter])[] = []
  const templates: ProviderTemplate[] = []

  for (const pack of packs) {
    const template: ProviderTemplate = { id: pack.id, ...pack.template }
    templates.push(template)

    if (!inferenceSeen.has(template.inferenceAdapterId)) {
      const adapter = pack.inferenceAdapter(adapterOptions)
      inferenceSeen.set(template.inferenceAdapterId, adapter)
      inferenceEntries.push([template.inferenceAdapterId, adapter])
    }

    if (template.usageAdapterId !== null && !usageSeen.has(template.usageAdapterId)) {
      const adapter = pack.usageAdapter(adapterOptions)
      usageSeen.set(template.usageAdapterId, adapter)
      usageEntries.push([template.usageAdapterId, adapter])
    }
  }

  return new AdapterRegistry({
    inferenceAdapters: inferenceEntries,
    usageAdapters: usageEntries,
    providerTemplates: templates,
  })
}

/**
 * The Adapter Registry every Iroha build ships with, built from the built-in
 * Provider Pack list: each Pack contributes its Provider Template, Inference
 * Adapter and Usage Adapter. The Pack list is the only source, so adding a
 * typed Provider is one Pack module and one line in that list — nothing here
 * changes. Tests pass `upstreamTransport` to build every Pack's adapters over
 * the stub transport; production omits it and each adapter reaches for the
 * runtime's own `fetch`.
 */
export function createBuiltInAdapterRegistry(
  options: BuiltInAdapterRegistryOptions = {},
): AdapterRegistry {
  return adapterRegistryFromPacks(
    BUILT_IN_PROVIDER_PACKS,
    options.upstreamTransport === undefined ? {} : { fetch: options.upstreamTransport },
  )
}
