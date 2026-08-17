import { request } from './api-client.ts'

export interface AuditEventView {
  readonly id: number
  readonly occurredAt: string
  readonly action: string
  readonly outcome: 'success' | 'failure'
  readonly detail: unknown
}

export interface AuditEventList {
  readonly events: readonly AuditEventView[]
  readonly total: number
}

export interface AuditFilter {
  readonly actionPrefix?: string
  readonly outcome?: 'success' | 'failure'
}

export async function fetchAudit(
  filter: AuditFilter = {},
  options: { limit?: number; offset?: number; signal?: AbortSignal } = {},
): Promise<AuditEventList> {
  const query = new URLSearchParams()
  if (filter.actionPrefix !== undefined && filter.actionPrefix !== '') {
    query.set('actionPrefix', filter.actionPrefix)
  }
  if (filter.outcome !== undefined) {
    query.set('outcome', filter.outcome)
  }
  if (options.limit !== undefined) query.set('limit', String(options.limit))
  if (options.offset !== undefined) query.set('offset', String(options.offset))
  const path = `/audit/${query.toString() === '' ? '' : `?${query.toString()}`}`
  return await request<AuditEventList>('GET', path, { signal: options.signal })
}

export async function clearAudit(csrfToken: string): Promise<number> {
  const body = await request<{ removed: number }>('DELETE', '/audit', { csrfToken })
  return body.removed
}