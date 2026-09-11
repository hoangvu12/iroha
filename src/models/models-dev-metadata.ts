import type { ModelCatalogMetadata } from '../persistence/index.ts'

export type ModelMetadataFallback = (
  providerHandle: string,
  modelIds: readonly string[],
) => Promise<Readonly<Record<string, ModelCatalogMetadata>>>

export interface ModelsDevMetadataFallbackOptions {
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  readonly clock?: () => number
  readonly cacheTtlMs?: number
  readonly endpoint?: string
}

interface ModelsDevEntry {
  readonly id: string
  readonly metadata: ModelCatalogMetadata
}

const DEFAULT_ENDPOINTS = [
  'https://models.dev/models.json',
  'https://raw.githubusercontent.com/anomalyco/models.dev/dev/models.json',
] as const
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1_000
const FETCH_TIMEOUT_MS = 10_000
const PREFIX_MATCH_MIN_SCORE = 70
const PREFIX_MATCH_MIN_SHARED_PARTS = 2

export function createModelsDevMetadataFallback(
  options: ModelsDevMetadataFallbackOptions = {},
): ModelMetadataFallback {
  const fetch = options.fetch ?? globalThis.fetch
  const clock = options.clock ?? Date.now
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  const endpoints = options.endpoint === undefined ? DEFAULT_ENDPOINTS : [options.endpoint]
  let cache: ReadonlyMap<string, ModelsDevEntry> = new Map()
  let loadedAt = 0
  let loading: Promise<ReadonlyMap<string, ModelsDevEntry>> | null = null

  const load = async (): Promise<ReadonlyMap<string, ModelsDevEntry>> => {
    const now = clock()
    if (cache.size > 0 && now - loadedAt < cacheTtlMs) return cache
    if (loading !== null) return await loading

    loading = (async () => {
      for (const endpoint of endpoints) {
        try {
          const response = await fetch(endpoint, {
            method: 'GET',
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          })
          if (!response.ok) continue
          const parsed = parseModelsDevCatalog(await response.json())
          if (parsed.size === 0) continue
          cache = parsed
          loadedAt = clock()
          return cache
        } catch {
          continue
        }
      }
      return cache
    })()
    try {
      return await loading
    } finally {
      loading = null
    }
  }

  return async (providerHandle, modelIds) => {
    const catalog = await load()
    const metadata: Record<string, ModelCatalogMetadata> = {}
    for (const modelId of modelIds) {
      const match = lookupModelsDevMetadata(`${providerHandle}/${modelId}`, catalog)
      if (match !== null) metadata[modelId] = match
    }
    return metadata
  }
}

export function parseModelsDevCatalog(raw: unknown): ReadonlyMap<string, ModelsDevEntry> {
  const entries = new Map<string, ModelsDevEntry>()
  if (!isRecord(raw)) return entries

  for (const [providerId, provider] of Object.entries(raw)) {
    if (!isRecord(provider)) continue
    if (isRecord(provider.models)) {
      for (const [fallbackId, model] of Object.entries(provider.models)) {
        if (!isRecord(model)) continue
        addModelsDevEntry(entries, providerId, fallbackId, model)
      }
    } else {
      addModelsDevEntry(entries, null, providerId, provider)
    }
  }
  return entries
}

function addModelsDevEntry(
  entries: Map<string, ModelsDevEntry>,
  providerId: string | null,
  fallbackId: string,
  model: Record<string, unknown>,
): void {
  const rawId = typeof model.id === 'string' && model.id.trim() !== '' ? model.id.trim() : fallbackId
  const id = rawId.includes('/') || providerId === null ? rawId : `${providerId}/${rawId}`
  const metadata = readModelsDevMetadata(model)
  if (metadata !== null) entries.set(id.toLowerCase(), { id, metadata })
}

export function lookupModelsDevMetadata(
  qualifiedModelId: string,
  catalog: ReadonlyMap<string, ModelsDevEntry>,
): ModelCatalogMetadata | null {
  const lowered = qualifiedModelId.toLowerCase()
  const direct = catalog.get(lowered)
  if (direct !== undefined) return direct.metadata

  const cleanId = cleanQualifiedId(lowered)
  const exact = catalog.get(cleanId)
  if (exact !== undefined) return exact.metadata

  const requestedModel = modelPortion(cleanId)
  const exactModelMatches = distinctMetadata(
    [...catalog.values()]
      .filter((candidate) => modelPortion(cleanQualifiedId(candidate.id.toLowerCase())) === requestedModel)
      .map((candidate) => candidate.metadata),
  )
  if (exactModelMatches.length === 1) return exactModelMatches[0] ?? null
  if (exactModelMatches.length > 1) return null

  let bestScore = 0
  let best: ModelCatalogMetadata[] = []
  for (const candidate of catalog.values()) {
    const score = prefixScore(
      requestedModel,
      modelPortion(cleanQualifiedId(candidate.id.toLowerCase())),
    )
    if (score < PREFIX_MATCH_MIN_SCORE) continue
    if (score > bestScore) {
      bestScore = score
      best = [candidate.metadata]
    } else if (score === bestScore) {
      best.push(candidate.metadata)
    }
  }
  const matches = distinctMetadata(best)
  return matches.length === 1 ? matches[0] ?? null : null
}

function readModelsDevMetadata(model: Record<string, unknown>): ModelCatalogMetadata | null {
  const limit = isRecord(model.limit) ? model.limit : {}
  const normalizedName = typeof model.name === 'string' && model.name.trim() !== ''
    ? model.name.trim()
    : null
  const contextLength = positiveInteger(limit.context) ?? positiveInteger(limit.input)
  const maxInputTokens = positiveInteger(limit.input)
  const maxOutputTokens = positiveInteger(limit.output)
  if (normalizedName === null && contextLength === null && maxInputTokens === null && maxOutputTokens === null) {
    return null
  }
  return { normalizedName, contextLength, maxInputTokens, maxOutputTokens }
}

function cleanQualifiedId(id: string): string {
  const withoutVariant = id.replace(/:[a-z0-9_-]+$/i, '')
  const parts = withoutVariant.split('/')
  return parts.length > 2 ? parts.slice(-2).join('/') : withoutVariant
}

function modelPortion(id: string): string {
  const separator = id.indexOf('/')
  return separator === -1 ? id : id.slice(separator + 1)
}

function prefixScore(left: string, right: string): number {
  const leftParts = left.split('-')
  const rightParts = right.split('-')
  const shorter = leftParts.length <= rightParts.length ? leftParts : rightParts
  const longer = leftParts.length <= rightParts.length ? rightParts : leftParts
  for (let index = 0; index < shorter.length; index += 1) {
    if (shorter[index] !== longer[index]) return 0
  }
  if (shorter.length < PREFIX_MATCH_MIN_SHARED_PARTS) return 0
  return Math.max(0, 100 - (longer.length - shorter.length) * 10)
}

function distinctMetadata(values: readonly ModelCatalogMetadata[]): ModelCatalogMetadata[] {
  const distinct = new Map<string, ModelCatalogMetadata>()
  for (const value of values) distinct.set(JSON.stringify(value), value)
  return [...distinct.values()]
}

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
