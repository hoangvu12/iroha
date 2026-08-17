import { request } from './api-client.ts'

export interface RetentionView {
  readonly days: number
  readonly enabled: boolean
}

export async function fetchRetention(signal?: AbortSignal): Promise<RetentionView> {
  return await request<RetentionView>('GET', '/settings/request-history', { signal })
}

export async function updateRetention(days: number, csrfToken: string): Promise<RetentionView> {
  return await request<RetentionView>('PUT', '/settings/request-history', {
    body: { days },
    csrfToken,
  })
}
