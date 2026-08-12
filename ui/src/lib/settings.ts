export interface RetentionView {
  readonly days: number
  readonly enabled: boolean
}

export class SettingsError extends Error {
  readonly code: string
  readonly problems: readonly { readonly field: string; readonly message: string }[]

  constructor(
    code: string,
    message: string,
    problems: readonly { readonly field: string; readonly message: string }[] = [],
  ) {
    super(message)
    this.name = 'SettingsError'
    this.code = code
    this.problems = problems
  }
}

export async function fetchRetention(signal?: AbortSignal): Promise<RetentionView> {
  return await request<RetentionView>('GET', '/request-history', { signal })
}

export async function updateRetention(days: number, csrfToken: string): Promise<RetentionView> {
  return await request<RetentionView>('PUT', '/request-history', { body: { days }, csrfToken })
}

async function request<T = unknown>(
  method: string,
  path: string,
  options: { body?: unknown; csrfToken?: string; signal?: AbortSignal } = {},
): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api/v1/admin/settings${path}`, {
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
    throw new SettingsError('unreachable', 'Iroha did not answer. Check that the gateway is running.')
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

function toError(payload: unknown): SettingsError {
  const error = (payload as { error?: { code?: unknown; message?: unknown; problems?: unknown } })
    ?.error
  return new SettingsError(
    typeof error?.code === 'string' ? error.code : 'request_failed',
    typeof error?.message === 'string' ? error.message : 'That request could not be completed.',
    Array.isArray(error?.problems) ? (error.problems as SettingsError['problems']) : [],
  )
}