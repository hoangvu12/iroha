import { Elysia, t } from 'elysia'
import type { GatewayKeyRegistry } from '../keys/index.ts'
import type { Database } from '../persistence/index.ts'
import { bearerToken } from './bearer-token.ts'

export function createGlobalModelRoutes(options: { readonly gatewayKeys: GatewayKeyRegistry; readonly database: Database }) {
  return new Elysia({ name: 'iroha/global-models' }).get('/v1/models', async ({ request }) => {
    const discovery = await options.gatewayKeys.discover(bearerToken(request.headers) ?? '')
    if (!discovery.ok) {
      return Response.json(
        { error: { code: 'gateway_key_invalid', message: 'This Gateway Key is not valid.' } },
        { status: 401 },
      )
    }

    const token = bearerToken(request.headers)
    const models: { id: string; object: 'model'; created: number }[] = []
    for (const provider of await options.database.providers.listProviders()) {
      if (provider.archivedAt !== null || !provider.enabled) continue
      const authorization = await options.gatewayKeys.authorizeProvider(provider.id, token)
      if (!authorization.ok) continue
      const entries = await options.database.modelCatalog.listEntries(provider.id)
      const effective = new Map(entries.filter((entry) => !entry.excluded).map((entry) => [entry.modelId, entry]))
      const candidates = authorization.models === null ? [...effective.keys()] : authorization.models
      for (const modelId of candidates) {
        const entry = effective.get(modelId)
        if (entry === undefined) continue
        models.push({ id: `${provider.handle}/${modelId}`, object: 'model', created: Math.floor(entry.createdAt.getTime() / 1000) })
      }
    }
    models.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    return Response.json({ object: 'list', data: [...new Map(models.map((model) => [model.id, model])).values()] })
  }, {
    detail: { hide: true, summary: 'List globally qualified models' },
    response: {
      200: t.Object({ object: t.Literal('list'), data: t.Array(t.Object({ id: t.String(), object: t.Literal('model'), created: t.Number() })) }),
    },
  })
}
