import { request } from './api-client.ts'

export interface CatalogOverrides {
  readonly chat?: boolean
  readonly streaming?: boolean
  readonly tools?: boolean
  readonly structuredOutput?: boolean
  readonly responses?: boolean
}

export interface CatalogEntryView {
  readonly modelId: string
  readonly source: 'discovered' | 'template' | 'owner_added' | 'excluded'
  readonly excluded: boolean
  readonly overrides: CatalogOverrides | null
  readonly updatedAt: string
}

export interface CatalogSyncView {
  readonly syncedAt: string | null
  readonly lastSuccessAt: string | null
  readonly lastFailureAt: string | null
  readonly lastFailureMessage: string | null
  readonly stale: boolean
}

export interface CatalogView {
  readonly sync: CatalogSyncView
  readonly entries: readonly CatalogEntryView[]
}

export async function fetchCatalog(
  providerId: string,
  signal?: AbortSignal,
): Promise<CatalogView> {
  return await request<CatalogView>(
    'GET',
    `/providers/${encodeURIComponent(providerId)}/catalog`,
    { signal },
  )
}

export async function refreshCatalog(
  providerId: string,
  csrfToken: string,
): Promise<CatalogView> {
  return await request<CatalogView>(
    'POST',
    `/providers/${encodeURIComponent(providerId)}/catalog/refresh`,
    { csrfToken },
  )
}

export async function addOwnerModel(
  providerId: string,
  modelId: string,
  csrfToken: string,
): Promise<CatalogView> {
  return await request<CatalogView>(
    'POST',
    `/providers/${encodeURIComponent(providerId)}/catalog/models`,
    { body: { modelId }, csrfToken },
  )
}

export async function setModelExcluded(
  providerId: string,
  modelId: string,
  excluded: boolean,
  csrfToken: string,
): Promise<CatalogView> {
  return await request<CatalogView>(
    'PATCH',
    `/providers/${encodeURIComponent(providerId)}/catalog/models/${encodeURIComponent(modelId)}`,
    { body: { excluded }, csrfToken },
  )
}

export async function updateModelOverrides(
  providerId: string,
  modelId: string,
  overrides: CatalogOverrides,
  csrfToken: string,
): Promise<CatalogView> {
  return await request<CatalogView>(
    'PATCH',
    `/providers/${encodeURIComponent(providerId)}/catalog/models/${encodeURIComponent(modelId)}`,
    { body: { overrides }, csrfToken },
  )
}

export async function removeOwnerModel(
  providerId: string,
  modelId: string,
  csrfToken: string,
): Promise<CatalogView> {
  return await request<CatalogView>(
    'DELETE',
    `/providers/${encodeURIComponent(providerId)}/catalog/models/${encodeURIComponent(modelId)}`,
    { csrfToken },
  )
}