import { Elysia, t } from 'elysia'
import type { GatewayKeyRegistry } from '../keys/index.ts'
import type { Database, ModelCatalogEntryRecord } from '../persistence/index.ts'
import { bearerToken } from './bearer-token.ts'
import { inlineModelMetadata } from './model-metadata.ts'

export function createGlobalModelRoutes(options: { readonly gatewayKeys: GatewayKeyRegistry; readonly database: Database }) {
  return new Elysia({ name: 'iroha/global-models' }).get('/v1/models', async ({ request }) => {
    // One authorization and one catalog read serve the whole listing. Doing
    // either per Provider costs a database round trip per Provider, which is
    // what pushed this endpoint past the model-discovery deadline of clients
    // that give it a few seconds before giving up on the Provider entirely.
    const authorization = await options.gatewayKeys.authorizeCatalog(bearerToken(request.headers))
    if (!authorization.ok) {
      return Response.json(
        { error: { code: 'gateway_key_invalid', message: 'This Gateway Key is not valid.' } },
        { status: 401 },
      )
    }

    const entriesByProvider = new Map<string, ModelCatalogEntryRecord[]>()
    for (const entry of await options.database.modelCatalog.listEntriesByProviders(
      authorization.providers.map((provider) => provider.id),
    )) {
      if (entry.excluded) continue
      const group = entriesByProvider.get(entry.providerId)
      if (group === undefined) entriesByProvider.set(entry.providerId, [entry])
      else group.push(entry)
    }

    const models: {
      id: string
      object: 'model'
      created: number
      normalized_name?: string
      context_length?: number
      max_input_tokens?: number
      max_output_tokens?: number
      chat?: 'ok' | 'unsupported'
      architecture?: {
        readonly input_modalities?: readonly string[]
        readonly output_modalities?: readonly string[]
      }
    }[] = []
    for (const provider of authorization.providers) {
      const effective = new Map(
        (entriesByProvider.get(provider.id) ?? []).map((entry) => [entry.modelId, entry]),
      )
      const candidates = provider.models === null ? [...effective.keys()] : provider.models
      for (const modelId of candidates) {
        const entry = effective.get(modelId)
        if (entry === undefined) continue
        models.push({
          id: `${provider.handle}/${modelId}`,
          object: 'model',
          created: Math.floor(entry.createdAt.getTime() / 1000),
          ...inlineModelMetadata(entry.metadata, entry.overrides),
        })
      }
    }
    models.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    return Response.json({ object: 'list', data: [...new Map(models.map((model) => [model.id, model])).values()] })
  }, {
    detail: { hide: true, summary: 'List globally qualified models' },
    response: {
      200: t.Object({ object: t.Literal('list'), data: t.Array(t.Object({
        id: t.String(),
        object: t.Literal('model'),
        created: t.Number(),
        normalized_name: t.Optional(t.String()),
        context_length: t.Optional(t.Number()),
        max_input_tokens: t.Optional(t.Number()),
        max_output_tokens: t.Optional(t.Number()),
        chat: t.Optional(t.Union([t.Literal('ok'), t.Literal('unsupported')])),
        architecture: t.Optional(t.Object({
          input_modalities: t.Optional(t.Array(t.String())),
          output_modalities: t.Optional(t.Array(t.String())),
        })),
      })) }),
    },
  })
}
