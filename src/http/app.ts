import { openapi } from '@elysiajs/openapi'
import { Elysia, t } from 'elysia'
import type { SecretCipher } from '../crypto/index.ts'
import type { InferenceAdapter } from '../inference/index.ts'
import { createGenericInferenceAdapter } from '../inference/generic-adapter.ts'
import type { OwnerIdentity } from '../identity/index.ts'
import type { GatewayKeyRegistry } from '../keys/index.ts'
import { ModelCatalogService } from '../models/index.ts'
import type { Database } from '../persistence/index.ts'
import type { ProviderConnectionRegistry } from '../providers/index.ts'
import type { Timer } from '../runtime/timer.ts'
import { createAdminRoutes } from './admin.ts'
import { createAuthRoutes } from './auth.ts'
import { createCatalogRoutes } from './catalog.ts'
import { createDirectoryRoutes } from './directory.ts'
import { createFrontendHandler, type FrontendHandler } from './frontend.ts'
import { createInferenceRoutes, type StreamingTimeouts } from './inference.ts'
import { ReadinessState } from './readiness.ts'

export interface AppOptions {
  readonly database: Database
  readonly readiness: ReadinessState
  readonly identity: OwnerIdentity
  readonly providers: ProviderConnectionRegistry
  readonly gatewayKeys: GatewayKeyRegistry
  /** Decrypts stored Upstream Keys for the catalog's read-only discovery GET. */
  readonly secretCipher?: SecretCipher | undefined
  /** Directory holding the built management UI. Omit to serve the API alone. */
  readonly frontendDirectory?: string | undefined
  /** The inference surface's transport. Omit for the runtime's real fetch. */
  readonly inference?: InferenceAdapter | undefined
  /** Replaces the catalog service built from the other options. */
  readonly modelCatalog?: ModelCatalogService | undefined
  /** Streaming deadlines; tests inject a fake timer to drive them. */
  readonly timer?: Timer
  readonly streamingTimeouts?: StreamingTimeouts
}

const liveResponse = t.Object({ status: t.Literal('alive') })

const readyResponse = t.Object({
  status: t.Literal('ready'),
  database: t.Object({ dialect: t.Union([t.Literal('sqlite'), t.Literal('postgres')]) }),
})

const notReadyResponse = t.Object({
  status: t.Literal('not_ready'),
  reason: t.Union([
    t.Literal('migrations_pending'),
    t.Literal('shutting_down'),
    t.Literal('database_unavailable'),
  ]),
})

/**
 * The fully assembled application, exposed as a Web `fetch` interface.
 *
 * Tests drive this object directly rather than binding a port, which is the
 * seam the spec names: real repositories, real routing, no network.
 */
export function createApp(options: AppOptions) {
  const { database, readiness, identity, providers, gatewayKeys } = options
  const frontend: FrontendHandler | null = options.frontendDirectory
    ? createFrontendHandler(options.frontendDirectory)
    : null
  const inference = options.inference ?? createGenericInferenceAdapter()
  // The catalog shares the inference adapter so a test transport override
  // governs discovery exactly as it governs inference.
  const modelCatalog =
    options.modelCatalog ??
    (() => {
      if (options.secretCipher === undefined) {
        throw new Error('createApp requires a modelCatalog or a secretCipher')
      }
      return new ModelCatalogService({ database, cipher: options.secretCipher, inference })
    })()

  return new Elysia()
    .use(openapi({ path: '/docs', documentation: { info: { title: 'Iroha', version: '0.1.0' } } }))
    .use(createAuthRoutes({ identity }))
    .use(createAdminRoutes({ identity, providers, gatewayKeys }))
    .use(createDirectoryRoutes({ gatewayKeys }))
    .use(createCatalogRoutes({ identity, modelCatalog }))
    .use(createInferenceRoutes({
      gatewayKeys,
      providers,
      inference,
      modelCatalog,
      ...(options.timer === undefined ? {} : { timer: options.timer }),
      ...(options.streamingTimeouts === undefined
        ? {}
        : { timeouts: options.streamingTimeouts }),
    }))
    .get('/health/live', () => ({ status: 'alive' as const }), {
      detail: {
        summary: 'Process liveness',
        description:
          'Reports that the Iroha process is running. It does not consider migrations, the database, or upstream Providers, so a restart loop cannot be triggered by an outage Iroha cannot fix by restarting.',
      },
      response: { 200: liveResponse },
    })
    .get(
      '/health/ready',
      async ({ status }) => {
        const staticReason = readiness.staticReason()
        if (staticReason !== null) {
          return status(503, { status: 'not_ready' as const, reason: staticReason })
        }

        try {
          await database.ping()
        } catch {
          // The failure detail names the connection target, which readiness
          // does not disclose to an unauthenticated caller.
          return status(503, { status: 'not_ready' as const, reason: 'database_unavailable' as const })
        }

        return { status: 'ready' as const, database: { dialect: database.dialect } }
      },
      {
        detail: {
          summary: 'Traffic readiness',
          description:
            'Reports that configuration is valid, migrations have completed, and the database is responding. Upstream Provider outages do not affect this result.',
        },
        response: { 200: readyResponse, 503: notReadyResponse },
      },
    )
    .get('/*', ({ request }) => {
      const path = new URL(request.url).pathname

      // A mistyped API path must not answer with the management application,
      // which would look like success to a client expecting JSON.
      if (path.startsWith('/api/')) {
        return Response.json(
          { error: { code: 'not_found', message: 'No such endpoint.' } },
          { status: 404 },
        )
      }

      if (frontend === null) {
        return new Response('Not found', { status: 404 })
      }
      return frontend(path)
    })
}

export type App = ReturnType<typeof createApp>
export { ReadinessState }
