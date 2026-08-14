import { useEffect, useState } from 'react'
import { fetchProviderTemplates, type ProviderTemplateBrand } from './providers.ts'

/**
 * Resolves a Provider Template's brand identity by id. Templates are fetched
 * once per page and cached in module state; every component that renders
 * ProviderIcon reaches the same lookup so a navigation never refetches.
 *
 * Returns `null` while loading and during fetch errors; the icon falls back
 * to the generic server mark in both cases. The Owner is signed in when the
 * management UI renders, so a 401 here is the only real failure mode and
 * the generic fallback is the right answer.
 */

type BrandLookup = ReadonlyMap<string, ProviderTemplateBrand>

const cache: { readonly value: BrandLookup } = { value: new Map() }
let inflight: Promise<void> | null = null

async function refresh(): Promise<void> {
  try {
    const templates = await fetchProviderTemplates()
    const map = new Map<string, ProviderTemplateBrand>()
    for (const template of templates) {
      if (template.brand !== null) map.set(template.id, template.brand)
    }
    ;(cache as { value: BrandLookup }).value = map
  } catch {
    // The Owner-facing surface already renders the generic icon when brand
    // is null; we silently keep whatever the cache had.
  } finally {
    inflight = null
  }
}

function ensureLoaded(): void {
  if (inflight === null && cache.value.size === 0) {
    inflight = refresh()
  }
}

export function useBrandByTemplateId(): {
  readonly brandFor: (templateId: string | null) => ProviderTemplateBrand | null
} {
  const [, force] = useState(0)

  useEffect(() => {
    ensureLoaded()
    if (inflight !== null) {
      void inflight.then(() => force((tick) => tick + 1))
    }
  }, [])

  return {
    brandFor(templateId) {
      if (templateId === null || templateId === '') return null
      return cache.value.get(templateId) ?? null
    },
  }
}
