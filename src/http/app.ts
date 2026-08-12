import { openapi } from '@elysiajs/openapi'
import { Elysia, t } from 'elysia'
import type { OwnerIdentity } from '../identity/index.ts'
import type { Database } from '../persistence/index.ts'
import type { ProviderConnectionRegistry } from '../providers/index.ts'
import { createAdminRoutes } from './admin.ts'
import { createAuthRoutes } from './auth.ts'
import { createFrontendHandler, type FrontendHandler } from './frontend.ts'
import { ReadinessState } from './readiness.ts'

export interface AppOptions {
  readonly database: Database
  readonly readiness: ReadinessState
  readonly identity: OwnerIdentity
  readonly providers: ProviderConnectionRegistry
  /** Directory holding the built management UI. Omit to serve the API alone. */
  readonly frontendDirectory?: string | undefined
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
  const { database, readiness, identity, providers } = options
  const frontend: FrontendHandler | null = options.frontendDirectory
    ? createFrontendHandler(options.frontendDirectory)
    : null

  return new Elysia()
    .use(openapi({ path: '/docs', documentation: { info: { title: 'Iroha', version: '0.1.0' } } }))
    .use(createAuthRoutes({ identity }))
    .use(createAdminRoutes({ identity, providers }))
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
