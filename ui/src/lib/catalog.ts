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

export class CatalogError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'CatalogError'
    this.code = code
  }
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

async function request<T = unknown>(
  method: string,
  path: string,
  options: { body?: unknown; csrfToken?: string; signal?: AbortSignal } = {},
): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api/v1/admin${path}`, {
      method,
      credentials: 'same-origin',
      ...(options.signal ? { signal: options.signal } : {}),
      headers: {
        accept: 'application/json',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.csrfToken === undefined ? {} : { 'x-iroha-csrf': options.csrfToken }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
  } catch {
    throw new CatalogError('unreachable', 'Iroha did not answer. Check that the gateway is running.')
  }

  if (response.status === 204) return undefined as T

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) throw toError(payload)
  return payload as T
}

function toError(payload: unknown): CatalogError {
  const error = (payload as { error?: { code?: unknown; message?: unknown } })?.error
  return new CatalogError(
    typeof error?.code === 'string' ? error.code : 'request_failed',
    typeof error?.message === 'string' ? error.message : 'That request could not be completed.',
  )
}