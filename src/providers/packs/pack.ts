/**
 * Provider Pack: Iroha's complete built-in knowledge of one upstream brand —
 * one Provider Template, one Inference Adapter, and one Usage Adapter — in one
 * module (ADR-0019).
 *
 * A Pack is a declaration only. It holds its Provider Template as data and
 * references its adapter factories; the adapter behaviour always lives in its
 * own module beside the Pack, never inside it, whatever its size. That rule
 * has no exception, so the location of a Provider's behaviour is always
 * predictable.
 *
 * A Pack's id is the Provider Template id it carries, so nothing persisted
 * changes and no migration is required. The Template data the Pack holds omits
 * an id of its own — the Pack supplies it — so the id is declared exactly once.
 */

import type { InferenceAdapter } from '../../inference/adapter.ts'
import type { UsageAdapter } from '../../usage/adapter.ts'
import type { ProviderTemplate } from '../templates.ts'

/**
 * The knobs a Pack's adapter factory accepts. Only the upstream transport is
 * injectable, and only the test harness injects it — production lets each
 * factory reach for the runtime's own `fetch`.
 */
export interface PackAdapterOptions {
  /** Injectable upstream transport; production uses the runtime's fetch. */
  readonly fetch?: typeof fetch
}

/** The Provider Template data a Pack carries, minus the id the Pack supplies. */
export type PackTemplate = Omit<ProviderTemplate, 'id'>

/**
 * One upstream brand's built-in knowledge: the Provider Template it seeds
 * Providers with, and the factories that build its Inference and Usage
 * Adapters. The factories are referenced, never invoked, at declaration time;
 * the Adapter Registry and the test harness build the adapters when they need
 * them.
 */
export interface ProviderPack {
  /** The Pack's id — the Provider Template id it carries. */
  readonly id: string
  /** The Provider Template data this Pack seeds Providers with, minus its id. */
  readonly template: PackTemplate
  /** Builds this Pack's Inference Adapter, optionally over an injected transport. */
  readonly inferenceAdapter: (options?: PackAdapterOptions) => InferenceAdapter
  /** Builds this Pack's Usage Adapter, optionally over an injected transport. */
  readonly usageAdapter: (options?: PackAdapterOptions) => UsageAdapter
}
