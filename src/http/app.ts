import { openapi } from '@elysiajs/openapi'
import { Elysia, t } from 'elysia'
import { BrandLogoService } from '../brand-logos/index.ts'
import type { SecretCipher } from '../crypto/index.ts'
import { RequestHistoryService } from '../history/index.ts'
import type { InferenceAdapter } from '../inference/index.ts'
import { createGenericInferenceAdapter } from '../inference/generic-adapter.ts'
import type { OwnerIdentity } from '../identity/index.ts'
import type { GatewayKeyRegistry } from '../keys/index.ts'
import { BackgroundScheduleSettingsService } from '../jobs/index.ts'
import { ModelCatalogService, templateAvailabilityFromRegistry, templateKnowledgeFromRegistry } from '../models/index.ts'
import type { Database } from '../persistence/index.ts'
import type { AdapterRegistry } from '../providers/adapter-registry.ts'
import { createBuiltInAdapterRegistry } from '../providers/adapter-registry.ts'
import type { ProviderRegistry } from '../providers/index.ts'
import type { ShutdownController } from '../runtime/shutdown.ts'
import type { Timer } from '../runtime/timer.ts'
import { UsageService, type UsageAdapter } from '../usage/index.ts'
import { createGenericUsageAdapter } from '../usage/generic-adapter.ts'
import { createAdminRoutes } from './admin.ts'
import { createAuditRoutes } from './audit.ts'
import { createAuthRoutes } from './auth.ts'
import { createBackgroundRoutes } from './background-jobs.ts'
import { type SchedulerSurface, StaticScheduler } from './background-scheduler-surface.ts'
import { createBrandLogoRoutes } from './brand-logos.ts'
import { createCatalogRoutes } from './catalog.ts'
import { createDirectoryRoutes } from './directory.ts'
import { createFrontendHandler, type FrontendHandler } from './frontend.ts'
import { createAdminInferenceRoutes, createGlobalInferenceRoutes, createInferenceRoutes, DEFAULT_TRANSPORT, type StreamingTimeouts, type TransportDefaults } from './inference.ts'
import { createRequestHistoryRoutes } from './request-history.ts'
import { ReadinessState } from './readiness.ts'
import { createSettingsRoutes } from './settings.ts'
import { createUsageRoutes } from './usage.ts'
import { createMetricsRoutes } from './metrics.ts'
import { createGlobalModelRoutes } from './global-models.ts'
import { MetricsCollector, MetricsSettingsService } from '../metrics/metrics.ts'

export interface AppOptions {
  readonly database: Database
  readonly readiness: ReadinessState
  readonly identity: OwnerIdentity
  readonly providers: ProviderRegistry
  readonly gatewayKeys: GatewayKeyRegistry
  /** Decrypts stored Upstream Keys for the catalog's read-only discovery GET. */
  readonly secretCipher?: SecretCipher | undefined
  /** Directory holding the built management UI. Omit to serve the API alone. */
  readonly frontendDirectory?: string | undefined
  /** The inference surface's transport. Omit for the runtime's real fetch. */
  readonly inference?: InferenceAdapter | undefined
  /**
   * The Adapter Registry that supplies Provider Templates for the admin
   * picker and template knowledge for the catalog service. Defaults to the
   * built-in registry when omitted, so test apps that assemble their own
   * services can skip the wiring without losing any default.
   */
  readonly adapterRegistry?: AdapterRegistry | undefined
  /** Replaces the catalog service built from the other options. */
  readonly modelCatalog?: ModelCatalogService | undefined
  /** Replaces the Usage Adapter the Usage Service polls. */
  readonly usageAdapter?: UsageAdapter | undefined
  /** Replaces the usage service built from the other options. */
  readonly usageService?: UsageService | undefined
  /** Replaces the request-history service built from the other options. */
  readonly requestHistory?: RequestHistoryService | undefined
  /** Replaces the background schedule settings built from the database. */
  readonly backgroundSchedule?: BackgroundScheduleSettingsService | undefined
  /** Replaces the background scheduler surface built from the other options. */
  readonly backgroundScheduler?: SchedulerSurface | undefined
  readonly metrics?: MetricsCollector | undefined
  readonly metricsSettings?: MetricsSettingsService | undefined
  /** Streaming deadlines; tests inject a fake timer to drive them. */
  readonly timer?: Timer
  readonly shutdown?: ShutdownController
  readonly streamingTimeouts?: StreamingTimeouts
  /** Overrides the transport defaults read from the global settings store. */
  readonly transportDefaults?: TransportDefaults | undefined
  readonly retrySleep?: (ms: number, signal: AbortSignal) => Promise<void>
  /**
   * The brand logo service that serves cached logo.dev images for Provider
   * Templates. When omitted, no brand route is mounted and the UI falls back
   * to its generic icon. The token the service holds is configured by the
   * deployment; tests inject their own.
   */
  readonly brandLogos?: BrandLogoService | undefined
}

const liveResponse = t.Object({ status: t.Literal('alive') })

const readyResponse = t.Object({
  status: t.Literal('ready'),
  database: t.Object({ dialect: t.Union([t.Literal('sqlite'), t.Literal('postgres')]) }),
})

const notReadyResponse = t.Object({
  status: t.Literal('not_ready'),
  reason:     t.Union([
    t.Literal('configuration_invalid'),
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
  const adapterRegistry = options.adapterRegistry ?? createBuiltInAdapterRegistry()
  // The catalog shares the inference adapter so a test transport override
  // governs discovery exactly as it governs inference.
  const modelCatalog =
    options.modelCatalog ??
    (() => {
      if (options.secretCipher === undefined) {
        throw new Error('createApp requires a modelCatalog or a secretCipher')
      }
      return new ModelCatalogService({
        database,
        cipher: options.secretCipher,
        inference,
        templateKnowledge: templateKnowledgeFromRegistry(adapterRegistry),
        templateAvailability: templateAvailabilityFromRegistry(adapterRegistry),
      })
    })()
  const usageService =
    options.usageService ??
    (() => {
      if (options.secretCipher === undefined) {
        throw new Error('createApp requires a usageService or a secretCipher')
      }
      return new UsageService({
        database,
        cipher: options.secretCipher,
        adapter: options.usageAdapter ?? createGenericUsageAdapter(),
        adapterRegistry,
      })
    })()

  const requestHistory = options.requestHistory ?? new RequestHistoryService({ database })

  const backgroundSchedule = options.backgroundSchedule ?? new BackgroundScheduleSettingsService({ database })

  const backgroundScheduler: SchedulerSurface = options.backgroundScheduler ?? new StaticScheduler(database)

  readiness.markConfigured()

  const metrics = options.metrics ?? new MetricsCollector(
    options.timer === undefined ? {} : { now: () => options.timer!.now() },
  )
  const metricsSettings = options.metricsSettings ?? new MetricsSettingsService(database)

  const transportDefaults: TransportDefaults = options.transportDefaults ?? DEFAULT_TRANSPORT

  return new Elysia()
    .get('/docs/capability-matrix', () => new Response(capabilityMatrixPage, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }))
    .onRequest(({ request }) => {
      if (isTrackedInferenceRequest(request)) metrics.begin(request)
    })
    .mapResponse(({ request, responseValue }) => {
      if (isTrackedInferenceRequest(request)) {
        metrics.finish(request, responseValue instanceof Response ? responseValue.status : null)
      }
    })
    .use(openapi({
      path: '/docs',
      documentation: {
        info: {
          title: 'Iroha',
          version: '0.1.0',
          description: 'Iroha discovery and Owner administration APIs. The OpenAI-compatible provider-scoped surface is linked to the capability matrix rather than duplicated here.',
        },
        externalDocs: { description: 'Iroha OpenAI capability matrix', url: '/docs/capability-matrix' },
        tags: [
          { name: 'Auth', description: 'Owner session lifecycle: first-run setup, sign in, sign out, session list and revocation, and recovery.' },
          { name: 'Health', description: 'Process liveness and traffic-readiness probes.' },
          { name: 'Providers', description: 'Provider lifecycle: list, create, inspect, edit, archive, duplicate, and purge.' },
          { name: 'Provider Templates', description: 'Built-in Provider Templates the Owner can seed a new Provider from.' },
          { name: 'Upstream Keys', description: 'Upstream Key lifecycle scoped to one Provider: add, configure, test, activate, disable, remove.' },
          { name: 'Upstream Accounts', description: 'Upstream Account groupings that share Provider billing or capacity across keys.' },
          { name: 'Gateway Keys', description: 'Application credentials the Owner issues: list, create, inspect, revoke, and self-discover permitted Providers.' },
          { name: 'Catalog', description: 'Per-Provider model catalog: discover, refresh, add, exclude, override capabilities, remove.' },
          { name: 'Usage', description: 'Per-Provider Usage Adapter reading and on-demand refresh.' },
          { name: 'Audit', description: 'Administrative event log.' },
          { name: 'Request History', description: 'Read-only inference metadata, including the request-history retention setting.' },
          { name: 'Settings', description: 'Iroha-wide settings the Owner can read or update.' },
          { name: 'Background Jobs', description: 'Scheduled job status, manual triggers, and per-job schedule settings.' },
          { name: 'Metrics', description: 'Bounded Prometheus metrics and the optional exposure switch.' },
          { name: 'Brand Logos', description: 'Cached logo.dev images for built-in Provider Templates, served from the server-side proxy so the vendor token never reaches the browser.' },
        ],
        components: {
          securitySchemes: {
            GatewayKey: { type: 'http', scheme: 'bearer', bearerFormat: 'Gateway Key' },
            OwnerSession: { type: 'apiKey', in: 'cookie', name: 'iroha_session' },
          },
        },
      },
    }))
    .use(createAuthRoutes({ identity }))
    .use(createAdminRoutes({ identity, providers, gatewayKeys, adapterRegistry, modelCatalog }))
    .use(
      createAdminInferenceRoutes(identity, {
        gatewayKeys, providers, inference, modelCatalog, adapterRegistry, database, requestHistory,
        transportDefaults, usageService,
        ...(options.timer === undefined ? {} : { timer: options.timer }),
        ...(options.shutdown === undefined ? {} : { shutdown: options.shutdown }),
        ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
        ...(options.streamingTimeouts === undefined ? {} : { timeouts: options.streamingTimeouts }),
        ...(options.retrySleep === undefined ? {} : { retrySleep: options.retrySleep }),
      }),
    )
    .use(createDirectoryRoutes({ gatewayKeys }))
    .use(createGlobalModelRoutes({ gatewayKeys, database }))
    .use(createBrandLogoRoutes({ brandLogos: options.brandLogos ?? noBrandLogoService(), identity }))
    .use(createCatalogRoutes({ identity, modelCatalog }))
    .use(
      createUsageRoutes({
        identity,
        usage: usageService,
      }),
    )
    .use(
      createAuditRoutes({
        identity,
        database,
      }),
    )
    .use(
      createRequestHistoryRoutes({
        identity,
        requestHistory,
      }),
    )
    .use(
      createSettingsRoutes({
        identity,
        requestHistory,
        database,
      }),
    )
    .use(
      createBackgroundRoutes({
        identity,
        database,
        scheduler: backgroundScheduler,
        settings: backgroundSchedule,
      }),
    )
    .use(
      createMetricsRoutes({
        identity,
        database,
        providers,
        metrics,
        metricsSettings,
      }),
    )
    .use(
      createInferenceRoutes({
        gatewayKeys,
        providers,
        inference,
        modelCatalog,
        adapterRegistry,
        database,
        requestHistory,
        transportDefaults,
        usageService,
        ...(options.timer === undefined ? {} : { timer: options.timer }),
        ...(options.shutdown === undefined ? {} : { shutdown: options.shutdown }),
        ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
        ...(options.streamingTimeouts === undefined
          ? {}
          : { timeouts: options.streamingTimeouts }),
        ...(options.retrySleep === undefined ? {} : { retrySleep: options.retrySleep }),
      }),
    )
    .use(
      createGlobalInferenceRoutes({
        gatewayKeys, providers, inference, modelCatalog, adapterRegistry, database, requestHistory,
        transportDefaults, usageService,
        ...(options.timer === undefined ? {} : { timer: options.timer }),
        ...(options.shutdown === undefined ? {} : { shutdown: options.shutdown }),
        ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
        ...(options.streamingTimeouts === undefined ? {} : { timeouts: options.streamingTimeouts }),
        ...(options.retrySleep === undefined ? {} : { retrySleep: options.retrySleep }),
      }),
    )
    .get('/health/live', () => ({ status: 'alive' as const }), {
      detail: {
        tags: ['Health'],
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
          tags: ['Health'],
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
const capabilityMatrixPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Iroha OpenAI capability matrix</title></head>
<body><h1>Iroha OpenAI capability matrix</h1>
<table><thead><tr><th>Surface</th><th>Capability</th><th>Notes</th></tr></thead><tbody>
<tr><td>Models</td><td>Provider-scoped list</td><td>Exact model IDs filtered by Gateway Key scope.</td></tr>
<tr><td>Chat Completions</td><td>Buffered and streaming</td><td>Tools, structured output, cancellation, unknown request fields, and OpenAI-shaped errors.</td></tr>
<tr><td>Responses</td><td>Buffered and streaming</td><td>Tools, structured output, cancellation, unknown request fields, and OpenAI-shaped errors.</td></tr>
<tr><td>All inference</td><td>Provider-aware routing</td><td>Connection capabilities and Key Health can constrain what is forwarded.</td></tr>
</tbody></table></body></html>`

function isTrackedInferenceRequest(request: Request): boolean {
  return request.method !== 'OPTIONS' && /^\/providers\/[^/]+\/v1\//.test(new URL(request.url).pathname)
}

export { StaticScheduler, type SchedulerSurface }

/**
 * Brand logo service used when the deployment did not configure one. The
 * route stays mounted so its response shape (and 404) is observable in every
 * environment, but every lookup returns null and the UI falls back to its
 * generic icon. A real service with an undefined token and no templates
 * reaches the early-return before any disk or network access.
 */
function noBrandLogoService(): BrandLogoService {
  return new BrandLogoService({
    token: undefined,
    cacheDirectory: './data/logos',
    templates: [],
  })
}
