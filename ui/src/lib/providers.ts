export interface KeyView {
  readonly id: string
  readonly health: 'unverified' | 'active' | 'disabled'
  readonly lastProbe: {
    readonly at: string
    readonly verdict: 'usable' | 'rejected' | 'inconclusive'
    readonly reason: string | null
  } | null
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

export interface ConnectionView {
  readonly id: string
  readonly displayName: string
  readonly baseUrl: string
  readonly allowInsecureHttp: boolean
  readonly enabled: boolean
  readonly archived: boolean
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

export async function fetchConnections(signal?: AbortSignal): Promise<readonly ConnectionView[]> {
  const body = await request<{ connections: readonly ConnectionView[] }>(
    'GET',
    '/provider-connections',
    { signal },
  )
  return body.connections
}

export async function createConnection(
  input: {
    displayName: string
    baseUrl: string
    upstreamKey: string
    allowInsecureHttp: boolean
  },
  csrfToken: string,
): Promise<ConnectionView> {
  return await request<ConnectionView>('POST', '/provider-connections', {
    body: input,
    csrfToken,
  })
}

export async function updateConnection(
  id: string,
  patch: {
    displayName?: string
    baseUrl?: string
    allowInsecureHttp?: boolean
    enabled?: boolean
  },
  csrfToken: string,
): Promise<ConnectionView> {
  return await request<ConnectionView>('PATCH', `/provider-connections/${encodeURIComponent(id)}`, {
    body: patch,
    csrfToken,
  })
}

export async function archiveConnection(id: string, csrfToken: string): Promise<ConnectionView> {
  return await request<ConnectionView>(
    'POST',
    `/provider-connections/${encodeURIComponent(id)}/archive`,
    { csrfToken },
  )
}

export async function duplicateConnection(id: string, csrfToken: string): Promise<ConnectionView> {
  return await request<ConnectionView>(
    'POST',
    `/provider-connections/${encodeURIComponent(id)}/duplicate`,
    { csrfToken },
  )
}

export async function purgeConnection(id: string, csrfToken: string): Promise<void> {
  await request(
    'POST',
    `/provider-connections/${encodeURIComponent(id)}/purge`,
    { csrfToken },
  )
}

export async function testKey(
  connectionId: string,
  keyId: string,
  csrfToken: string,
): Promise<ConnectionView> {
  return await request<ConnectionView>(
    'POST',
    `/provider-connections/${encodeURIComponent(connectionId)}/keys/${encodeURIComponent(keyId)}/test`,
    { csrfToken },
  )
}

export async function activateKey(
  connectionId: string,
  keyId: string,
  csrfToken: string,
): Promise<ConnectionView> {
  return await request<ConnectionView>(
    'POST',
    `/provider-connections/${encodeURIComponent(connectionId)}/keys/${encodeURIComponent(keyId)}/activate`,
    { csrfToken },
  )
}

export async function disableKey(
  connectionId: string,
  keyId: string,
  csrfToken: string,
): Promise<ConnectionView> {
  return await request<ConnectionView>(
    'POST',
    `/provider-connections/${encodeURIComponent(connectionId)}/keys/${encodeURIComponent(keyId)}/disable`,
    { csrfToken },
  )
}

export async function addKey(
  connectionId: string,
  upstreamKey: string,
  csrfToken: string,
): Promise<ConnectionView> {
  return await request<ConnectionView>(
    'POST',
    `/provider-connections/${encodeURIComponent(connectionId)}/keys`,
    { body: { upstreamKey }, csrfToken },
  )
}

export async function updateKeySettings(
  connectionId: string,
  keyId: string,
  settings: {
    accountId: string | null
    allowedModels: readonly string[] | null
    deniedModels: readonly string[] | null
  },
  csrfToken: string,
): Promise<ConnectionView> {
  return await request<ConnectionView>(
    'PATCH',
    `/provider-connections/${encodeURIComponent(connectionId)}/keys/${encodeURIComponent(keyId)}`,
    { body: settings, csrfToken },
  )
}

export async function removeKey(
  connectionId: string,
  keyId: string,
  csrfToken: string,
): Promise<ConnectionView> {
  return await request<ConnectionView>(
    'DELETE',
    `/provider-connections/${encodeURIComponent(connectionId)}/keys/${encodeURIComponent(keyId)}`,
    { csrfToken },
  )
}

export async function createUpstreamAccount(
  connectionId: string,
  displayName: string,
  csrfToken: string,
): Promise<ConnectionView> {
  return await request<ConnectionView>(
    'POST',
    `/provider-connections/${encodeURIComponent(connectionId)}/accounts`,
    { body: { displayName }, csrfToken },
  )
}

export async function deleteUpstreamAccount(
  connectionId: string,
  accountId: string,
  csrfToken: string,
): Promise<ConnectionView> {
  return await request<ConnectionView>(
    'DELETE',
    `/provider-connections/${encodeURIComponent(connectionId)}/accounts/${encodeURIComponent(accountId)}`,
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
