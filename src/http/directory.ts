import { Elysia, t } from 'elysia'
import type { DirectoryProvider, GatewayKeyRegistry } from '../keys/index.ts'

export interface DirectoryRoutesOptions {
  readonly gatewayKeys: GatewayKeyRegistry
}

const directoryProviderResponse = t.Object({
  id: t.String(),
  displayName: t.String(),
  url: t.String(),
  models: t.Array(t.String()),
  capabilities: t.Object({}),
})

const directoryResponse = t.Object({ providers: t.Array(directoryProviderResponse) })

const errorResponse = t.Object({
  error: t.Object({ code: t.String(), message: t.String() }),
})

/**
 * The Provider Directory: what an application may use, authenticated with its
 * Gateway Key. No Owner session is involved; the key's scope decides the whole
 * answer. Every failure answers the same way, so discovery never reveals which
 * keys or connections exist.
 */
export function createDirectoryRoutes({ gatewayKeys }: DirectoryRoutesOptions) {
  return new Elysia({ name: 'iroha/directory', prefix: '/api/v1/directory' })
    .get(
      '/providers',
      async ({ headers, status }) => {
        const token = bearerToken(headers)
        if (token === null) return status(401, gatewayKeyError())

        const result = await gatewayKeys.discover(token)
        if (!result.ok) return status(401, gatewayKeyError())

        return { providers: result.value.map(toDirectoryProviderDto) }
      },
      {
        detail: {
          summary: 'Discover permitted Provider Connections',
          description:
            'Lists only the Provider Connections and exact model IDs this Gateway Key is scoped to. Base URLs, balances, secrets, and health are never returned.',
        },
        response: { 200: directoryResponse, 401: errorResponse },
      },
    )
}

export type DirectoryRoutes = ReturnType<typeof createDirectoryRoutes>

type DirectoryProviderDto = typeof directoryProviderResponse.static

function toDirectoryProviderDto(provider: DirectoryProvider): DirectoryProviderDto {
  return {
    id: provider.id,
    displayName: provider.displayName,
    url: provider.url,
    models: [...provider.models],
    capabilities: {},
  }
}

/** Elysia exposes headers as a string record; only the bearer is read. */
function bearerToken(headers: Record<string, string | undefined>): string | null {
  const value = headers['authorization']
  if (value === undefined) return null

  const match = /^Bearer (.+)$/i.exec(value.trim())
  return match === null ? null : match[1]!.trim()
}

/**
 * One stable, sanitized answer for every failure: a wrong secret, a revoked
 * key, an unknown key, and a missing credential are indistinguishable.
 */
function gatewayKeyError() {
  return { error: { code: 'gateway_key_invalid', message: 'This Gateway Key is not valid.' } }
}
