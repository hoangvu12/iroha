import { Elysia, t } from 'elysia'
import type { OwnerIdentity } from '../identity/index.ts'
import type { ProviderConnectionRegistry } from '../providers/index.ts'
import type { Database, UpstreamKeyHealth } from '../persistence/index.ts'
import {
  ALL_KEY_HEALTH_STATES,
  MetricsCollector,
  MetricsSettingsService,
  MetricsSettingsValidationError,
} from '../metrics/metrics.ts'
import { createOwnerGuard, type ManagementError } from './owner-guard.ts'

export interface MetricsRoutesOptions {
  readonly identity: OwnerIdentity
  readonly database: Database
  readonly providers: ProviderConnectionRegistry
  readonly metrics: MetricsCollector
  readonly metricsSettings: MetricsSettingsService
}

const settingsResponse = t.Object({ enabled: t.Boolean() })
const errorResponse = t.Object({
  error: t.Object({
    code: t.String(),
    message: t.String(),
  }),
})

type ErrorDto = typeof errorResponse.static

export function createMetricsRoutes({
  identity,
  database,
  providers,
  metrics,
  metricsSettings,
}: MetricsRoutesOptions) {
  const guard = createOwnerGuard(identity)

  return new Elysia({ name: 'iroha/admin-metrics', prefix: '/api/v1/admin' })
    .get(
      '/metrics',
      async ({ request, cookie }) => {
        const result = await guard.requireOwner({ request, cookie }, { csrf: false })
        if ('response' in result) return errorResponseJson(result.response.status, result.response.body)
        if (!(await metricsSettings.read()).enabled) {
          return errorResponseJson(404, { error: { code: 'metrics_disabled', message: 'Metrics are disabled.' } })
        }

        const connections = await providers.list()
        const keyHealth = Object.fromEntries(ALL_KEY_HEALTH_STATES.map((health) => [health, 0])) as { [health in UpstreamKeyHealth]: number }
        for (const connection of connections) {
          for (const key of connection.keys) keyHealth[key.health] = (keyHealth[key.health] ?? 0) + 1
        }

        return new Response(metrics.render(keyHealth), {
          headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
        })
      },
      {
        detail: {
          tags: ['Metrics'],
          security: [{ OwnerSession: [] }],
          summary: 'Read bounded Iroha metrics',
          description:
            'Returns Prometheus-compatible request, latency, failure, retry, and bounded Key Health counters without Provider, model, key, or request identifiers.',
        },
        response: { 200: t.String(), 401: errorResponse, 403: errorResponse, 404: errorResponse },
      },
    )
    .get(
      '/settings/metrics',
      async ({ request, cookie }) => {
        const result = await guard.requireOwner({ request, cookie }, { csrf: false })
        if ('response' in result) return errorResponseJson(result.response.status, result.response.body)
        return Response.json(await metricsSettings.read())
      },
      {
        detail: {
          tags: ['Settings', 'Metrics'],
          security: [{ OwnerSession: [] }],
          summary: 'Read metrics exposure settings',
          description: 'Returns whether the optional authenticated metrics endpoint is enabled.',
        },
        response: { 200: settingsResponse, 401: errorResponse, 403: errorResponse },
      },
    )
    .put(
      '/settings/metrics',
      async ({ body, request, cookie }) => {
        const result = await guard.requireOwner({ request, cookie }, { csrf: true })
        if ('response' in result) return errorResponseJson(result.response.status, result.response.body)
        try {
          const stored = await metricsSettings.write(body)
          await database.audit.record({
            action: 'settings.metrics.updated',
            outcome: 'success',
            detail: { enabled: stored.enabled },
            at: new Date(),
          })
          return Response.json(stored)
        } catch (error) {
          if (error instanceof MetricsSettingsValidationError) {
            return errorResponseJson(400, { error: { code: 'validation_failed', message: error.message } })
          }
          throw error
        }
      },
      {
        detail: {
          tags: ['Settings', 'Metrics'],
          security: [{ OwnerSession: [] }],
          summary: 'Update metrics exposure settings',
          description: 'Enables or disables the optional authenticated metrics endpoint.',
        },
        response: {
          200: settingsResponse,
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
        },
      },
    )
}

function errorResponseJson(status: number, body: ManagementError | { readonly error: { readonly code: string; readonly message: string } }): Response {
  return Response.json(toErrorDto(body), { status })
}

function toErrorDto(body: { readonly error: { readonly code: string; readonly message: string } }): ErrorDto {
  return { error: { code: body.error.code, message: body.error.message } }
}
