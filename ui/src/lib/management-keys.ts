import { request } from './api-client'

export type ManagementKeyScope = 'admin:read' | 'admin:write' | 'upstream-keys:reveal'
export interface ManagementKeyView {
  readonly id: string
  readonly name: string
  readonly scopes: readonly ManagementKeyScope[]
  readonly createdAt: string
  readonly lastUsedAt: string | null
  readonly expiresAt: string | null
  readonly revokedAt: string | null
}
export interface CreatedManagementKey extends ManagementKeyView { readonly secret: string }

export async function fetchManagementKeys(): Promise<readonly ManagementKeyView[]> {
  return (await request<{ keys: ManagementKeyView[] }>('GET', '/management-keys/')).keys
}
export function createManagementKey(name: string, csrfToken: string): Promise<CreatedManagementKey> {
  return request('POST', '/management-keys/', { body: { name }, csrfToken })
}
export function revokeManagementKey(id: string, csrfToken: string): Promise<ManagementKeyView> {
  return request('POST', `/management-keys/${encodeURIComponent(id)}/revoke`, { csrfToken })
}
export function deleteManagementKey(id: string, csrfToken: string): Promise<void> {
  return request('DELETE', `/management-keys/${encodeURIComponent(id)}`, { csrfToken })
}
