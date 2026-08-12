export type UnreadyReason = 'migrations_pending' | 'shutting_down' | 'database_unavailable'

export type Readiness =
  | { state: 'ready'; dialect: 'sqlite' | 'postgres' }
  | { state: 'not_ready'; reason: UnreadyReason }
  | { state: 'unreachable' }

/**
 * Reads `/health/ready`. An unreachable gateway is a distinct result from an
 * unready one: the first means the browser cannot see Iroha at all, the second
 * means Iroha answered and explained why it is not serving traffic.
 */
export async function fetchReadiness(signal?: AbortSignal): Promise<Readiness> {
  let response: Response
  try {
    response = await fetch('/health/ready', { signal, headers: { accept: 'application/json' } })
  } catch {
    return { state: 'unreachable' }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { state: 'unreachable' }
  }

  if (response.ok && isReadyBody(body)) {
    return { state: 'ready', dialect: body.database.dialect }
  }

  if (isNotReadyBody(body)) {
    return { state: 'not_ready', reason: body.reason }
  }

  return { state: 'unreachable' }
}

function isReadyBody(
  body: unknown,
): body is { status: 'ready'; database: { dialect: 'sqlite' | 'postgres' } } {
  if (typeof body !== 'object' || body === null) return false
  const candidate = body as { status?: unknown; database?: { dialect?: unknown } }
  return (
    candidate.status === 'ready' &&
    (candidate.database?.dialect === 'sqlite' || candidate.database?.dialect === 'postgres')
  )
}

function isNotReadyBody(body: unknown): body is { status: 'not_ready'; reason: UnreadyReason } {
  if (typeof body !== 'object' || body === null) return false
  const candidate = body as { status?: unknown; reason?: unknown }
  return (
    candidate.status === 'not_ready' &&
    (candidate.reason === 'migrations_pending' ||
      candidate.reason === 'shutting_down' ||
      candidate.reason === 'database_unavailable')
  )
}
