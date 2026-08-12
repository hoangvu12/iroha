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
import { ModelCatalogService } from '../models/index.ts'
import { openDatabase, type Database } from '../persistence/index.ts'
import {
  createGenericKeyProbe,
  ProviderConnectionRegistry,
  type UpstreamKeyProbe,
} from '../providers/index.ts'
import { createGenericInferenceAdapter } from '../inference/generic-adapter.ts'
import type { Timer } from './timer.ts'
import { UsageService, type UsageAdapter } from '../usage/index.ts'
import { createGenericUsageAdapter } from '../usage/generic-adapter.ts'
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
  /** Replaces the fully assembled app the runtime listens on. */
  readonly appFactory?: typeof createApp
  /** Replaces the request-history service the scheduler reaches for. */
  readonly requestHistory?: RequestHistoryService
  /** Replaces the model catalog service the scheduler reaches for. */
  readonly modelCatalog?: ModelCatalogService
}

export interface RunningIroha {
  readonly configuration: IrohaConfiguration
  readonly database: Database
  readonly url: string
  readonly port: number
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

  const providers = new ProviderConnectionRegistry({
    database,
    cipher: createSecretCipher(configuration.masterKey),
    keyProbe: options.keyProbe ?? createGenericKeyProbe(),
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
    jobs: buildDefaultJobs({
      modelCatalog,
      providers,
      usage: usageService,
      requestHistory,
      removeExpiredSessions,
    }),
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
  backgroundScheduler.start()

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
    stop() {
      stopped ??= (async () => {
        readiness.beginShutdown()
        await backgroundScheduler.stop()
        await server.stop()
        await database.close()
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
