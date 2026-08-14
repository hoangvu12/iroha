import { createGenericInferenceAdapter, type InferenceAdapter } from '../inference/index.ts'
import {
  createGenericUsageAdapter,
  createMinimaxUsageAdapter,
  type UsageAdapter,
} from '../usage/index.ts'
import {
  BUILT_IN_PROVIDER_TEMPLATES,
  GENERIC_INFERENCE_ADAPTER_ID,
  MINIMAX_USAGE_ADAPTER_ID,
  REACTIVE_ONLY_USAGE_ADAPTER_ID,
  type ProviderTemplate,
} from './templates.ts'

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
}

/**
 * The Adapter Registry every Iroha build ships with: the generic Inference
 * Adapter, the reactive-only generic Usage Adapter, and the built-in Provider
 * Templates. Tests can construct their own registry through the constructor
 * to assert validation behaviour; production reaches for this constant.
 */
export function createBuiltInAdapterRegistry(): AdapterRegistry {
  return new AdapterRegistry({
    inferenceAdapters: inferenceAdapters({
      [GENERIC_INFERENCE_ADAPTER_ID]: createGenericInferenceAdapter(),
    }),
    usageAdapters: usageAdapters({
      [REACTIVE_ONLY_USAGE_ADAPTER_ID]: createGenericUsageAdapter(),
      [MINIMAX_USAGE_ADAPTER_ID]: createMinimaxUsageAdapter(),
    }),
  })
}