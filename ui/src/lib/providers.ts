export interface KeyView {
  readonly id: string
  readonly health:
    | 'unverified'
    | 'active'
    | 'cooling_down'
    | 'invalid_authentication'
    | 'exhausted'
    | 'disabled'
  /** The Key's own base URL override; null means inherit the Provider's default. */
  readonly baseUrl: string | null
  /** The base URL one upstream call should hit. The Key's override wins when set. */
  readonly effectiveBaseUrl: string
  readonly lastProbe: {
    readonly at: string
    readonly verdict: 'usable' | 'rejected' | 'inconclusive'
    readonly reason: string | null
  } | null
  readonly healthReason: string | null
  readonly healthChangedAt: string
  readonly retryAfterAt: string | null
  readonly healthScope: 'key' | 'account' | 'connection_model' | 'provider' | 'unknown'
  readonly healthScopeId: string | null
  readonly healthModel: string | null
  readonly accountId: string | null
  readonly allowedModels: readonly string[] | null
  readonly deniedModels: readonly string[] | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface UpstreamAccountView {
  readonly id: string
  readonly displayName: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ProviderView {
  readonly id: string
  readonly displayName: string
  readonly baseUrl: string
  readonly allowInsecureHttp: boolean
  readonly enabled: boolean
  readonly retryMaxAttempts: number
  readonly retryAmbiguousNetwork: boolean
  readonly archived: boolean
  readonly templateId: string | null
  readonly authHeader: string
  readonly authPrefix: string
  readonly staticHeaders: readonly { readonly name: string }[]
  readonly redirectAllowSameOrigin: boolean
  readonly connectionTimeoutMs: number
  readonly firstByteTimeoutMs: number
  readonly nonStreamingTotalTimeoutMs: number
  readonly streamingIdleTimeoutMs: number
  readonly totalRetryTimeoutMs: number
  readonly idempotencyHeader: string
  readonly warnings: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
  readonly keys: readonly KeyView[]
  readonly accounts: readonly UpstreamAccountView[]
}

export interface FieldProblem {
  readonly field: string
  readonly message: string
}

/** A failed management request, carrying the stable code the admin API returned. */
export class ManagementError extends Error {
  readonly code: string
  readonly problems: readonly FieldProblem[]

  constructor(code: string, message: string, problems: readonly FieldProblem[] = []) {
    super(message)
    this.name = 'ManagementError'
    this.code = code
    this.problems = problems
  }
}

const BASE = '/api/v1/admin'

export interface ProviderTemplateCapabilities {
  readonly chat: boolean
  readonly streaming: boolean
  readonly tools: boolean
  readonly structuredOutput: boolean
  readonly responses: boolean
}

export interface ProviderTemplateView {
  readonly id: string
  readonly displayName: string
  readonly description: string
  readonly baseUrl: string
  readonly authHeader: string
  readonly authPrefix: string
  readonly capabilities: ProviderTemplateCapabilities
  readonly knownModels: readonly string[]
  readonly inferenceAdapterId: string
  readonly usageAdapterId: string | null
}

export async function fetchProviders(signal?: AbortSignal): Promise<readonly ProviderView[]> {
  const body = await request<{ providers: readonly ProviderView[] }>('GET', '/providers', { signal })
  return body.providers
}

export async function fetchProviderTemplates(
  signal?: AbortSignal,
): Promise<readonly ProviderTemplateView[]> {
  const body = await request<{ templates: readonly ProviderTemplateView[] }>(
    'GET',
    '/provider-templates',
    { signal },
  )
  return body.templates
}

export async function createProvider(
  input: {
    displayName: string
    baseUrl: string
    keys: readonly { readonly upstreamKey: string; readonly baseUrl?: string }[]
    allowInsecureHttp: boolean
    templateId: string | null
  },
  csrfToken: string,
): Promise<ProviderView> {
  const body: Record<string, unknown> = {
    displayName: input.displayName,
    baseUrl: input.baseUrl,
    keys: input.keys.map((entry) => {
      const trimmedBaseUrl = entry.baseUrl?.trim() ?? ''
      const keyBody: { upstreamKey: string; baseUrl?: string } = {
        upstreamKey: entry.upstreamKey,
      }
      // A blank per-key URL means "inherit the Provider default" — the
      // server stores `null` in that case, so we omit the field rather
      // than send an empty string and let the server's `readKeyBaseUrl`
      // do the inheritance.
      if (trimmedBaseUrl !== '') keyBody.baseUrl = trimmedBaseUrl
      return keyBody
    }),
    allowInsecureHttp: input.allowInsecureHttp,
  }
  if (input.templateId !== null) body.templateId = input.templateId
  return await request<ProviderView>('POST', '/providers', {
    body,
    csrfToken,
  })
}

export async function updateProvider(
  id: string,
  patch: {
    displayName?: string
    baseUrl?: string
    allowInsecureHttp?: boolean
    enabled?: boolean
    retryMaxAttempts?: number
    retryAmbiguousNetwork?: boolean
  },
  csrfToken: string,
): Promise<ProviderView> {
  return await request<ProviderView>('PATCH', `/providers/${encodeURIComponent(id)}`, {
    body: patch,
    csrfToken,
  })
}

export async function archiveProvider(id: string, csrfToken: string): Promise<ProviderView> {
  return await request<ProviderView>(
    'POST',
    `/providers/${encodeURIComponent(id)}/archive`,
    { csrfToken },
  )
}

export async function duplicateProvider(id: string, csrfToken: string): Promise<ProviderView> {
  return await request<ProviderView>(
    'POST',
    `/providers/${encodeURIComponent(id)}/duplicate`,
    { csrfToken },
  )
}

export async function purgeProvider(id: string, csrfToken: string): Promise<void> {
  await request('POST', `/providers/${encodeURIComponent(id)}/purge`, { csrfToken })
}

export async function testKey(
  providerId: string,
  keyId: string,
  csrfToken: string,
): Promise<ProviderView> {
  return await request<ProviderView>(
    'POST',
    `/providers/${encodeURIComponent(providerId)}/keys/${encodeURIComponent(keyId)}/test`,
    { csrfToken },
  )
}

export async function revealKey(
  providerId: string,
  keyId: string,
): Promise<{ value: string }> {
  return await request<{ value: string }>(
    'GET',
    `/providers/${encodeURIComponent(providerId)}/keys/${encodeURIComponent(keyId)}/value`,
  )
}

export async function activateKey(
  providerId: string,
  keyId: string,
  csrfToken: string,
): Promise<ProviderView> {
  return await request<ProviderView>(
    'POST',
    `/providers/${encodeURIComponent(providerId)}/keys/${encodeURIComponent(keyId)}/activate`,
    { csrfToken },
  )
}

export async function disableKey(
  providerId: string,
  keyId: string,
  csrfToken: string,
): Promise<ProviderView> {
  return await request<ProviderView>(
    'POST',
    `/providers/${encodeURIComponent(providerId)}/keys/${encodeURIComponent(keyId)}/disable`,
    { csrfToken },
  )
}

export async function addKey(
  providerId: string,
  input: {
    readonly upstreamKey: string
    readonly baseUrl?: string | null
    readonly accountId: string | null
    readonly allowedModels: readonly string[] | null
    readonly deniedModels: readonly string[] | null
  },
  csrfToken: string,
): Promise<ProviderView> {
  const body: Record<string, unknown> = {
    upstreamKey: input.upstreamKey,
    ...(input.baseUrl !== undefined && input.baseUrl !== null ? { baseUrl: input.baseUrl } : {}),
    ...(input.accountId !== null ? { accountId: input.accountId } : {}),
    ...(input.allowedModels !== null ? { allowedModels: input.allowedModels } : {}),
    ...(input.deniedModels !== null ? { deniedModels: input.deniedModels } : {}),
  }
  return await request<ProviderView>(
    'POST',
    `/providers/${encodeURIComponent(providerId)}/keys`,
    { body, csrfToken },
  )
}

export async function updateKeySettings(
  providerId: string,
  keyId: string,
  settings: {
    accountId: string | null
    allowedModels: readonly string[] | null
    deniedModels: readonly string[] | null
    baseUrl?: string | null
  },
  csrfToken: string,
): Promise<ProviderView> {
  const body: Record<string, unknown> = {
    ...(settings.accountId !== null ? { accountId: settings.accountId } : {}),
    ...(settings.allowedModels !== null ? { allowedModels: settings.allowedModels } : {}),
    ...(settings.deniedModels !== null ? { deniedModels: settings.deniedModels } : {}),
    ...(settings.baseUrl !== undefined ? { baseUrl: settings.baseUrl } : {}),
  }
  return await request<ProviderView>(
    'PATCH',
    `/providers/${encodeURIComponent(providerId)}/keys/${encodeURIComponent(keyId)}`,
    { body, csrfToken },
  )
}

export async function removeKey(
  providerId: string,
  keyId: string,
  csrfToken: string,
): Promise<ProviderView> {
  return await request<ProviderView>(
    'DELETE',
    `/providers/${encodeURIComponent(providerId)}/keys/${encodeURIComponent(keyId)}`,
    { csrfToken },
  )
}

export async function createUpstreamAccount(
  providerId: string,
  displayName: string,
  csrfToken: string,
): Promise<ProviderView> {
  return await request<ProviderView>(
    'POST',
    `/providers/${encodeURIComponent(providerId)}/accounts`,
    { body: { displayName }, csrfToken },
  )
}

export async function updateUpstreamAccount(
  providerId: string,
  accountId: string,
  displayName: string,
  csrfToken: string,
): Promise<ProviderView> {
  return await request<ProviderView>(
    'PATCH',
    `/providers/${encodeURIComponent(providerId)}/accounts/${encodeURIComponent(accountId)}`,
    { body: { displayName }, csrfToken },
  )
}

export async function deleteUpstreamAccount(
  providerId: string,
  accountId: string,
  csrfToken: string,
): Promise<ProviderView> {
  return await request<ProviderView>(
    'DELETE',
    `/providers/${encodeURIComponent(providerId)}/accounts/${encodeURIComponent(accountId)}`,
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
    response = await fetch(`${BASE}${path}`, {
      method,
      // Same-origin credentials only: the management API refuses anything else.
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
    throw new ManagementError('unreachable', 'Iroha did not answer. Check that the gateway is running.')
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

function toError(payload: unknown): ManagementError {
  const error = (payload as { error?: { code?: unknown; message?: unknown; problems?: unknown } })
    ?.error

  return new ManagementError(
    typeof error?.code === 'string' ? error.code : 'request_failed',
    typeof error?.message === 'string' ? error.message : 'That request could not be completed.',
    Array.isArray(error?.problems) ? (error.problems as FieldProblem[]) : [],
  )
}