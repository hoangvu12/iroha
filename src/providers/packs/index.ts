/**
 * The built-in Provider Packs: Iroha's complete knowledge of every upstream
 * brand it ships with, one module per brand (ADR-0019). This list is the
 * single source of truth for which Providers Iroha knows — the Provider
 * Templates the Adapter Registry offers are derived from it, and documentation
 * and tests enumerate it directly.
 *
 * Order is the order the Owner sees in the Provider Template picker; the
 * generic OpenAI-compatible default comes first so the Owner is never nudged
 * toward a brand when a compatible service will do.
 */

import type { ProviderTemplate } from '../templates.ts'
import type { ProviderPack } from './pack.ts'
import { genericOpenaiPack } from './generic-openai.ts'
import { genericAnthropicPack } from './generic-anthropic.ts'
import { openaiPack } from './openai.ts'
import { openrouterPack } from './openrouter.ts'
import { dashscopePack } from './dashscope.ts'
import { minimaxPack } from './minimax.ts'
import { anthropicPack } from './anthropic.ts'
import { zaiPack } from './zai.ts'

export type { PackAdapterOptions, PackTemplate, ProviderPack } from './pack.ts'

/**
 * Every built-in Provider Pack, in Owner-facing picker order. Adding a typed
 * Provider is one new Pack module and one line here.
 */
export const BUILT_IN_PROVIDER_PACKS: readonly ProviderPack[] = [
  genericOpenaiPack,
  genericAnthropicPack,
  openaiPack,
  openrouterPack,
  dashscopePack,
  minimaxPack,
  anthropicPack,
  zaiPack,
]

/**
 * The built-in Provider Templates, derived from the Pack list. Each Pack
 * supplies the id its Template data omits, so the id is declared exactly once —
 * on the Pack. Order matches {@link BUILT_IN_PROVIDER_PACKS}.
 */
export const BUILT_IN_PROVIDER_TEMPLATES: readonly ProviderTemplate[] =
  BUILT_IN_PROVIDER_PACKS.map((pack) => ({ id: pack.id, ...pack.template }))

/** Looks one built-in template up by id. Returns null when the id is unknown. */
export function findBuiltInTemplate(id: string): ProviderTemplate | null {
  return BUILT_IN_PROVIDER_TEMPLATES.find((template) => template.id === id) ?? null
}
