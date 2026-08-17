import { request } from './api-client.ts'

export interface GatewayKeyScopeEntry {
  readonly providerId: string
  readonly models: readonly string[] | null
}

export type GatewayKeyAccess =
  | { readonly mode: 'all' }
  | { readonly mode: 'selected'; readonly providers: readonly GatewayKeyScopeEntry[] }

export interface GatewayKeyView {
  readonly id: string
  readonly name: string
  readonly scope: readonly GatewayKeyScopeEntry[]
  readonly access: GatewayKeyAccess
  readonly revision: number
  readonly corsOrigins: readonly string[]
  readonly createdAt: string
  readonly lastUsedAt: string | null
  readonly revoked: boolean
}

export interface CreatedGatewayKey extends GatewayKeyView {
  /** The full credential (`<id>.<secret>`). Shown once and then never again. */
  readonly secret: string
}

export async function fetchGatewayKeys(signal?: AbortSignal): Promise<readonly GatewayKeyView[]> {
  const body = await request<{ keys: readonly GatewayKeyView[] }>('GET', '/gateway-keys', { signal })
  return body.keys
}

export async function createGatewayKey(
  input: {
    name: string
    access: GatewayKeyAccess
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

export async function updateGatewayKey(
  id: string,
  input: { revision: number; name: string; access: GatewayKeyAccess; corsOrigins: readonly string[] },
  csrfToken: string,
): Promise<GatewayKeyView> {
  return await request<GatewayKeyView>('PATCH', `/gateway-keys/${encodeURIComponent(id)}`, {
    body: input,
    csrfToken,
  })
}

export async function deleteGatewayKey(id: string, csrfToken: string): Promise<void> {
  await request('DELETE', `/gateway-keys/${encodeURIComponent(id)}`, { csrfToken })
}
