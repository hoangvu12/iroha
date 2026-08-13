import { join } from 'node:path'
import {
  ConfigurationError,
  loadConfiguration,
  type EnvironmentSource,
  type IrohaConfiguration,
} from '../config/environment.ts'
import { createSecretCipher } from '../crypto/index.ts'
import { RequestHistoryService } from '../history/index.ts'
import { createApp } from '../http/app.ts'
import { ReadinessState } from '../http/readiness.ts'
import { OwnerIdentity, type PasswordHasher } from '../identity/index.ts'
import {
  BackgroundScheduleSettingsService,
  BackgroundScheduler,
  buildDefaultJobs,
} from '../jobs/index.ts'
import { GatewayKeyRegistry } from '../keys/index.ts'
import { ModelCatalogService, templateKnowledgeFromRegistry } from '../models/index.ts'
import { openDatabase, type Database } from '../persistence/index.ts'
import {
  AdapterRegistry,
  createBuiltInAdapterRegistry,
  createGenericKeyProbe,
  ProviderRegistry,
  type UpstreamKeyProbe,
} from '../providers/index.ts'
import { createGenericInferenceAdapter } from '../inference/generic-adapter.ts'
import { ShutdownController } from './shutdown.ts'
import { systemTimer, type Timer } from './timer.ts'
import { UsageService, type UsageAdapter } from '../usage/index.ts'
import { createGenericUsageAdapter } from '../usage/generic-adapter.ts'
import { MetricsCollector, MetricsSettingsService } from '../metrics/metrics.ts'
import type { Clock } from './clock.ts'

const DEFAULT_FRONTEND_DIRECTORY = join(import.meta.dir, '../../ui/dist')

export interface StartOptions {
  readonly environment?: EnvironmentSource
  readonly frontendDirectory?: string | undefined
  /** Startup progress sink. Defaults to the console. */
  readonly log?: (message: string) => void
  /** Injected at the composition boundary; production uses the real ones. */
  readonly clock?: Clock
  readonly timer?: Timer
  readonly passwordHasher?: PasswordHasher
  readonly keyProbe?: UpstreamKeyProbe
  readonly usageAdapter?: UsageAdapter
  /**
   * Replaces the built-in Adapter Registry. Tests inject their own to assert
   * validation behaviour; production uses the built-in set with the generic
   * Inference Adapter and the reactive-only generic Usage Adapter.
   */
  readonly adapterRegistry?: AdapterRegistry
  /** Replaces the fully assembled app the runtime listens on. */
  readonly appFactory?: typeof createApp
  /** Replaces the request-history service the scheduler reaches for. */
  readonly requestHistory?: RequestHistoryService
  /** Replaces the model catalog service the scheduler reaches for. */
  readonly modelCatalog?: ModelCatalogService
  readonly shutdownGraceMs?: number
}

export interface RunningIroha {
  readonly configuration: IrohaConfiguration
  readonly database: Database
  readonly url: string
  readonly port: number
  readonly shutdown: ShutdownController
  stop(): Promise<void>
}

/**
 * Brings Iroha up in the order the deployment contract requires: validate
 * configuration, open the configured database, apply every pending migration,
 * and only then bind the port. A failure at any step leaves nothing listening.
 */
export async function startIroha(options: StartOptions = {}): Promise<RunningIroha> {
  const log = options.log ?? ((message: string) => console.log(message))
  const configuration = loadConfiguration(options.environment ?? Bun.env)

  log(`Iroha starting with ${configuration.database.describe}`)
  if (configuration.database.dialect === 'sqlite' && !configuration.database.ephemeral) {
    log('  SQLite selected: this file must live on a volume that survives redeployment.')
  }

  const database = openDatabase(configuration.database)
  const readiness = new ReadinessState()
  readiness.markConfigured()

  try {
    await database.migrate()
  } catch (error) {
    // Serving traffic against a half-migrated schema is worse than not
    // starting, so the failure is fatal and the connection is released.
    await database.close().catch(() => undefined)
    throw error
  }

  readiness.markMigrated()
  log('  Migrations applied.')

  const identity = new OwnerIdentity({
    database,
    setupToken: configuration.setupToken,
    recoveryToken: configuration.recoveryToken,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.passwordHasher ? { passwordHasher: options.passwordHasher } : {}),
  })

  // The setup token is required only while the installation is unclaimed, so
  // the check needs the migrated database and belongs here rather than in
  // configuration parsing.
  const ownerExists = await identity.ownerExists()

  if (!ownerExists && configuration.setupToken === undefined) {
    await database.close().catch(() => undefined)
    throw new ConfigurationError([
      {
        variable: 'IROHA_SETUP_TOKEN',
        message: 'is required until the Owner account has been created',
      },
    ])
  }

  log(
    ownerExists
      ? '  Owner account present: first-run setup is closed.'
      : '  No Owner yet: first-run setup is open in the browser.',
  )

  const adapterRegistry = options.adapterRegistry ?? createBuiltInAdapterRegistry()

  const providers = new ProviderRegistry({
    database,
    cipher: createSecretCipher(configuration.masterKey),
    keyProbe: options.keyProbe ?? createGenericKeyProbe(),
    adapterRegistry,
  })

  const gatewayKeys = new GatewayKeyRegistry({
    database,
    ...(options.clock ? { clock: options.clock } : {}),
  })

  const secretCipher = createSecretCipher(configuration.masterKey)
  const usageService = new UsageService({
    database,
    cipher: secretCipher,
    adapter: options.usageAdapter ?? createGenericUsageAdapter(),
    ...(options.clock ? { clock: options.clock } : {}),
  })

  const requestHistory = options.requestHistory ?? new RequestHistoryService({ database })
  const modelCatalog = options.modelCatalog ?? new ModelCatalogService({
    database,
    cipher: secretCipher,
    inference: createGenericInferenceAdapter({ fetch: globalThis.fetch }),
    templateKnowledge: templateKnowledgeFromRegistry(adapterRegistry),
  })
  const backgroundSchedule = new BackgroundScheduleSettingsService({
    database,
    ...(options.clock ? { clock: options.clock } : {}),
  })

  // A few scheduled jobs may have been left `running` by a previous process;
  // resetting them to `idle` is what the Owner sees when the service comes
  // back up: every row is fresh, no card is stuck on a job that cannot
  // possibly finish.
  await database.backgroundJobs.resetRunning()

  const removeExpiredSessions = async (now: Date) => await database.sessions.removeExpired(now)
  const backgroundScheduler = new BackgroundScheduler({
    database,
    jobs: buildDefaultJobs(),
    settings: backgroundSchedule,
    collaborators: {
      modelCatalog,
      providers,
      usage: usageService,
      requestHistory,
      removeExpiredSessions,
    },
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.timer ? { timer: options.timer } : {}),
  })
  await backgroundScheduler.seed()
  backgroundScheduler.start()

  const shutdown = new ShutdownController({
    graceMs: options.shutdownGraceMs ?? configuration.shutdownGraceMs,
    timer: options.timer ?? systemTimer,
  })

  const metrics = new MetricsCollector()
  const metricsSettings = new MetricsSettingsService(database)
  const createAppFn = options.appFactory ?? createApp
  const app = createAppFn({
    database,
    readiness,
    identity,
    providers,
    gatewayKeys,
    secretCipher,
    frontendDirectory: options.frontendDirectory ?? DEFAULT_FRONTEND_DIRECTORY,
    usageAdapter: options.usageAdapter ?? createGenericUsageAdapter(),
    usageService,
    requestHistory,
    backgroundSchedule,
    backgroundScheduler,
    shutdown,
    metrics,
    metricsSettings,
  })

  const server = app.listen({ hostname: configuration.host, port: configuration.port })
  const port = server.server?.port ?? configuration.port
  const url = `http://${configuration.host}:${port}`
  log(`  Listening on ${url}`)

  let stopped: Promise<void> | null = null

  return {
    configuration,
    database,
    url,
    port,
    shutdown,
    stop() {
      stopped ??= (async () => {
        readiness.beginShutdown()
        const inferenceStop = shutdown.drain({
          onDeadline: async () => { await server.stop(true) },
        })
        const backgroundStop = backgroundScheduler.stop()
        try {
          await Promise.all([inferenceStop, backgroundStop])
        } finally {
          await server.stop(true)
          await database.close()
        }
      })()
      return stopped
    },
  }
}

/**
 * Renders a startup failure for an operator's terminal. Configuration problems
 * are listed together and never include the offending values.
 */
export function describeStartupFailure(error: unknown): string {
  if (error instanceof ConfigurationError) {
    return error.message
  }

  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? `\n  Caused by: ${error.cause.message}` : ''
    return `Iroha failed to start: ${error.message}${cause}`
  }

  return `Iroha failed to start: ${String(error)}`
}
