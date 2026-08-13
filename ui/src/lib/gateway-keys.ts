export interface GatewayKeyScopeEntry {
  readonly providerId: string
  readonly models: readonly string[] | null
}

export interface GatewayKeyView {
  readonly id: string
  readonly name: string
  readonly scope: readonly GatewayKeyScopeEntry[]
  readonly corsOrigins: readonly string[]
  readonly createdAt: string
  readonly lastUsedAt: string | null
  readonly revoked: boolean
}

export interface CreatedGatewayKey extends GatewayKeyView {
  /** The full credential (`<id>.<secret>`). Shown once and then never again. */
  readonly secret: string
}

export interface FieldProblem {
  readonly field: string
  readonly message: string
}

/** A failed management request, carrying the stable code the admin API returned. */
export class GatewayKeyError extends Error {
  readonly code: string
  readonly problems: readonly FieldProblem[]

  constructor(code: string, message: string, problems: readonly FieldProblem[] = []) {
    super(message)
    this.name = 'GatewayKeyError'
    this.code = code
    this.problems = problems
  }
}

export async function fetchGatewayKeys(signal?: AbortSignal): Promise<readonly GatewayKeyView[]> {
  const body = await request<{ keys: readonly GatewayKeyView[] }>('GET', '/gateway-keys', { signal })
  return body.keys
}

export async function createGatewayKey(
  input: {
    name: string
    scope: readonly GatewayKeyScopeEntry[]
    corsOrigins: readonly string[]
  },
  csrfToken: string,
): Promise<CreatedGatewayKey> {
  return await request<CreatedGatewayKey>('POST', '/gateway-keys', { body: input, csrfToken })
}

export async function revokeGatewayKey(id: string, csrfToken: string): Promise<GatewayKeyView> {
  return await request<GatewayKeyView>('POST', `/gateway-keys/${encodeURIComponent(id)}/revoke`, {
    csrfToken,
  })
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
    throw new GatewayKeyError('unreachable', 'Iroha did not answer. Check that the gateway is running.')
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

function toError(payload: unknown): GatewayKeyError {
  const error = (payload as { error?: { code?: unknown; message?: unknown; problems?: unknown } })
    ?.error
  return new GatewayKeyError(
    typeof error?.code === 'string' ? error.code : 'request_failed',
    typeof error?.message === 'string' ? error.message : 'That request could not be completed.',
    Array.isArray(error?.problems) ? (error.problems as FieldProblem[]) : [],
  )
}