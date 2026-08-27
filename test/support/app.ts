import { createSecretCipher, type SecretCipher } from '../../src/crypto/index.ts'
import { createApp } from '../../src/http/app.ts'
import type { StreamingTimeouts, TransportDefaults } from '../../src/http/inference.ts'
import { ReadinessState } from '../../src/http/readiness.ts'
import { OwnerIdentity, type PasswordHasher } from '../../src/identity/index.ts'
import { createGenericInferenceAdapter } from '../../src/inference/index.ts'
import { GatewayKeyRegistry } from '../../src/keys/index.ts'
import { BackgroundScheduleSettingsService } from '../../src/jobs/index.ts'
import { ModelCatalogService, templateAvailabilityFromRegistry, templateDiscoveryFromRegistry, templateKnowledgeFromRegistry } from '../../src/models/index.ts'
import type { Database } from '../../src/persistence/index.ts'
import {
  createBuiltInAdapterRegistry,
  ProviderRegistry,
  type KeyProbeResult,
  type UpstreamKeyProbe,
} from '../../src/providers/index.ts'
import type { AdapterRegistry } from '../../src/providers/adapter-registry.ts'
import type { ShutdownController } from '../../src/runtime/shutdown.ts'
import type { Timer } from '../../src/runtime/timer.ts'
import { UsageService, type UsageAdapter } from '../../src/usage/index.ts'
import { createGenericUsageAdapter } from '../../src/usage/generic-adapter.ts'
import { sqliteEngine } from '../persistence/engines.ts'
import { testClock, testPasswordHasher, type TestClock } from './identity.ts'
import { stubUpstreamTransport } from './inference.ts'
import { RequestHistoryService } from '../../src/history/index.ts'
import { StaticScheduler } from '../../src/http/background-scheduler-surface.ts'
import { MetricsCollector, MetricsSettingsService } from '../../src/metrics/metrics.ts'
import type { BrandLogoService } from '../../src/brand-logos/index.ts'

export const ORIGIN = 'http://iroha.test'

/** Long and stable so tests can both encrypt and decrypt stored material. */
export const TEST_MASTER_KEY = 'test-master-key-do-not-use-in-production-01234'

export interface TestApp {
  readonly app: ReturnType<typeof createApp>
  readonly database: Database
  readonly identity: OwnerIdentity
  readonly clock: TestClock
  /** The probe the app's Provider Connection registry is using. */
  readonly upstreamKeyProbe: UpstreamKeyProbe
  readonly providers: ProviderRegistry
  readonly gatewayKeys: GatewayKeyRegistry
  readonly modelCatalog: ModelCatalogService
  /** The Adapter Registry the assembled app is using. */
  readonly adapterRegistry: AdapterRegistry
  /** The Usage Adapter the assembled app is using; tests usually inject one. */
  readonly usageAdapter: UsageAdapter
  /** The Usage Service the assembled app is using. */
  readonly usageService: UsageService
  readonly metrics: MetricsCollector
  readonly metricsSettings: MetricsSettingsService
  /** Sends a request the way a same-origin browser would. */
  fetch(path: string, init?: RequestInit & { csrf?: string }): Promise<Response>
  dispose(): Promise<void>
}

export interface TestAppOptions {
  readonly setupToken?: string | undefined
  readonly recoveryToken?: string | undefined
  readonly sessionIdleSeconds?: number
  /** Replaces the cheap test hasher, for tests that watch how it is used. */
  readonly passwordHasher?: PasswordHasher
  /** Replaces the key probe; defaults to one that answers "authenticated". */
  readonly upstreamKeyProbe?: UpstreamKeyProbe | undefined
  /** Replaces the inference upstream transport; defaults to a closed stub. */
  readonly upstreamTransport?: typeof fetch | undefined
  readonly secretCipher?: SecretCipher
  /**
   * Replaces the Adapter Registry. Defaults to the built-in one; tests can
   * supply a registry with a malformed declaration to assert validation.
   */
  readonly adapterRegistry?: AdapterRegistry
  /** Replaces the Usage Adapter; defaults to the reactive-only generic one. */
  readonly usageAdapter?: UsageAdapter
  /** Replaces the background schedule settings service. */
  readonly backgroundSchedule?: BackgroundScheduleSettingsService
  /** Replaces the background scheduler surface the management route reaches for. */
  readonly backgroundScheduler?: import('../../src/http/background-scheduler-surface.ts').SchedulerSurface
  /** Streaming deadlines; tests inject a fake timer to drive them. */
  readonly timer?: Timer
  readonly shutdown?: ShutdownController
  readonly streamingTimeouts?: StreamingTimeouts
  /** Transport defaults; tests can override CORS allow-list, etc. */
  readonly transportDefaults?: TransportDefaults
  readonly retrySleep?: (ms: number, signal: AbortSignal) => Promise<void>
  /** Replaces the brand logo service the assembled app uses. */
  readonly brandLogos?: BrandLogoService
}

export const SETUP_TOKEN = 'setup-token-for-tests-0123456789abcdef'
export const RECOVERY_TOKEN = 'recovery-token-for-tests-0123456789abcd'

/**
 * A probe whose answer the test controls. It also records what it was asked,
 * so a test can prove the key under test actually reached the Provider seam.
 */
export interface FakeKeyProbe extends UpstreamKeyProbe {
  readonly calls: readonly { readonly baseUrl: string; readonly upstreamKey: string }[]
  respondWith(result: KeyProbeResult): void
}

export function fakeKeyProbe(initial: KeyProbeResult = { verdict: 'authenticated', reason: null }): FakeKeyProbe {
  let answer = initial
  const calls: { baseUrl: string; upstreamKey: string }[] = []

  return {
    calls,
    respondWith(result: KeyProbeResult): void {
      answer = result
    },
    async test(request) {
      calls.push(request)
      return answer
    },
  }
}

/** The standard Provider Connection registry for tests that only need one to exist. */
export function providerRegistryFor(database: Database): ProviderRegistry {
  return new ProviderRegistry({
    database,
    cipher: createSecretCipher(TEST_MASTER_KEY),
    keyProbe: fakeKeyProbe(),
    adapterRegistry: createBuiltInAdapterRegistry(),
  })
}

/** The standard Gateway Key registry for tests that assemble an app by hand. */
export function gatewayKeyRegistryFor(database: Database): GatewayKeyRegistry {
  return new GatewayKeyRegistry({ database })
}

/** The standard model catalog service for tests that assemble an app by hand. */
export function modelCatalogFor(
  database: Database,
  adapterRegistry: AdapterRegistry = createBuiltInAdapterRegistry(),
): ModelCatalogService {
  return new ModelCatalogService({
    database,
    cipher: createSecretCipher(TEST_MASTER_KEY),
    inference: createGenericInferenceAdapter({ fetch: stubUpstreamTransport() }),
    templateKnowledge: templateKnowledgeFromRegistry(adapterRegistry),
    templateAvailability: templateAvailabilityFromRegistry(adapterRegistry),
    templateDiscovery: templateDiscoveryFromRegistry(adapterRegistry),
  })
}

/** The standard Usage Service for tests that assemble an app by hand. */
export function usageServiceFor(database: Database, adapter?: UsageAdapter): UsageService {
  return new UsageService({
    database,
    cipher: createSecretCipher(TEST_MASTER_KEY),
    adapter: adapter ?? createGenericUsageAdapter(),
  })
}

/**
 * The seam the spec names: the assembled application driven through its Web
 * `fetch` interface, over a real database, with only time, password cost, the
 * master key, and the upstream transport replaced.
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const { database, dispose } = await sqliteEngine.open()
  const clock = testClock()

  const identity = new OwnerIdentity({
    database,
    setupToken: 'setupToken' in options ? options.setupToken : SETUP_TOKEN,
    recoveryToken: options.recoveryToken,
    clock,
    passwordHasher: options.passwordHasher ?? testPasswordHasher,
    ...(options.sessionIdleSeconds === undefined
      ? {}
      : { sessionIdleSeconds: options.sessionIdleSeconds }),
  })

  // Elysia cannot report a caller address for a request handled without a
  // server, so every test request shares the throttle's unknown source.

  const upstreamKeyProbe = options.upstreamKeyProbe ?? fakeKeyProbe()
  const upstreamTransport = options.upstreamTransport ?? stubUpstreamTransport()
  const inference = createGenericInferenceAdapter({ fetch: upstreamTransport })
  // One mechanism: every built-in Provider Pack's adapters are built over the
  // test's upstream transport, so no Provider can escape to the real network
  // and adding a Pack needs no new injection line here.
  const adapterRegistry = options.adapterRegistry ?? createBuiltInAdapterRegistry({
    upstreamTransport,
  })
  const providers = new ProviderRegistry({
    database,
    cipher: options.secretCipher ?? createSecretCipher(TEST_MASTER_KEY),
    keyProbe: upstreamKeyProbe,
    adapterRegistry,
    clock,
  })

  const gatewayKeys = new GatewayKeyRegistry({ database, clock })

  const readiness = new ReadinessState()
  readiness.markMigrated()
  const modelCatalog = new ModelCatalogService({
    database,
    cipher: options.secretCipher ?? createSecretCipher(TEST_MASTER_KEY),
    inference,
    templateKnowledge: templateKnowledgeFromRegistry(adapterRegistry),
    templateAvailability: templateAvailabilityFromRegistry(adapterRegistry),
    templateDiscovery: templateDiscoveryFromRegistry(adapterRegistry),
  })
  const usageAdapter = options.usageAdapter ?? createGenericUsageAdapter()
  const usageService = new UsageService({
    database,
    cipher: options.secretCipher ?? createSecretCipher(TEST_MASTER_KEY),
    adapter: usageAdapter,
    clock,
  })
  const backgroundSchedule = options.backgroundSchedule ?? new BackgroundScheduleSettingsService({ database, clock })
  const backgroundScheduler = options.backgroundScheduler ?? new StaticScheduler(database)
  const requestHistory = new RequestHistoryService({ database, clock })
  const metrics = new MetricsCollector()
  const metricsSettings = new MetricsSettingsService(database)

  // Test apps default to a real scheduler so the management route can list
  // jobs and trigger them; tests that want to silence the scheduler pass
  // their own StaticScheduler explicitly through options.backgroundScheduler.
  const app = createApp({
    database,
    readiness,
    identity,
    providers,
    gatewayKeys,
    secretCipher: options.secretCipher ?? createSecretCipher(TEST_MASTER_KEY),
    inference,
    adapterRegistry,
    modelCatalog,
    usageAdapter,
    usageService,
    requestHistory,
    backgroundSchedule,
    backgroundScheduler,
    metrics,
    metricsSettings,
    ...(options.timer === undefined ? {} : { timer: options.timer }),
    ...(options.shutdown === undefined ? {} : { shutdown: options.shutdown }),
    ...(options.streamingTimeouts === undefined
      ? {}
      : { streamingTimeouts: options.streamingTimeouts }),
    ...(options.transportDefaults === undefined
      ? {}
      : { transportDefaults: options.transportDefaults }),
    ...(options.brandLogos === undefined ? {} : { brandLogos: options.brandLogos }),
    retrySleep:
      options.retrySleep ??
      (async (_ms, signal) => {
        await Promise.resolve()
        if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      }),
  })

  const cookies = new Map<string, string>()

  return {
    app,
    database,
    identity,
    clock,
    upstreamKeyProbe,
    providers,
    gatewayKeys,
    modelCatalog,
    adapterRegistry,
    usageAdapter,
    usageService,
    metrics,
    metricsSettings,

    async fetch(path, init = {}) {
      const { csrf, headers, ...rest } = init
      const request = new Request(`${ORIGIN}${path}`, {
        ...rest,
        headers: {
          origin: ORIGIN,
          'user-agent': 'Test Browser',
          ...(cookies.size > 0
            ? { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') }
            : {}),
          ...(csrf === undefined ? {} : { 'x-iroha-csrf': csrf }),
          ...((headers as Record<string, string>) ?? {}),
        },
      })

      const response = await app.handle(request)
      rememberCookies(cookies, response)
      return response
    },

    dispose,
  }
}

/**
 * Drives the assembled application the way a plain HTTP client would, so an
 * external library (for example the OpenAI SDK) can reach the app through its
 * own `fetch`.
 */
export function appFetch(app: ReturnType<typeof createApp>): typeof fetch {
  return (async (input: Request | URL | string, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    return await app.handle(new Request(url, init))
  }) as unknown as typeof fetch
}

/** A minimal cookie jar: enough to behave like the browser for these flows. */
function rememberCookies(jar: Map<string, string>, response: Response): void {
  for (const header of response.headers.getSetCookie()) {
    const [pair = '', ...attributes] = header.split(';')
    const separator = pair.indexOf('=')
    if (separator < 0) continue

    const name = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1).trim()
    const expired = attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute))

    if (expired || value === '') jar.delete(name)
    else jar.set(name, value)
  }
}

/** The stable error code a management response reported. */
export async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: unknown } }
  return typeof body.error?.code === 'string' ? body.error.code : '(no error code)'
}

export interface AuthenticationStateBody {
  readonly setupRequired: boolean
  readonly authenticated: boolean
  readonly recoveryEnabled: boolean
  readonly owner: { username: string } | null
  readonly session: { id: string; csrfToken: string } | null
}

export async function authState(test: TestApp): Promise<AuthenticationStateBody> {
  const response = await test.fetch('/api/v1/auth/state')
  return (await response.json()) as AuthenticationStateBody
}

export interface SignedIn {
  readonly csrf: string
  readonly sessionId: string
}

/** Completes first-run setup and returns what a signed-in browser holds. */
export async function completeSetup(
  test: TestApp,
  credentials: { username?: string; password?: string; setupToken?: string } = {},
): Promise<SignedIn> {
  const response = await test.fetch('/api/v1/auth/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: credentials.username ?? 'owner',
      password: credentials.password ?? 'correct horse battery staple',
      setupToken: credentials.setupToken ?? SETUP_TOKEN,
    }),
  })

  if (response.status !== 201) {
    throw new Error(`Setup failed with ${response.status}: ${await response.text()}`)
  }

  return heldSession(await response.json())
}

export async function signIn(
  test: TestApp,
  credentials: { username?: string; password?: string } = {},
): Promise<SignedIn> {
  const response = await test.fetch('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: credentials.username ?? 'owner',
      password: credentials.password ?? 'correct horse battery staple',
    }),
  })

  if (response.status !== 200) {
    throw new Error(`Login failed with ${response.status}: ${await response.text()}`)
  }

  return heldSession(await response.json())
}

function heldSession(body: unknown): SignedIn {
  const session = (body as AuthenticationStateBody).session
  if (session === null) throw new Error('The response carried no session')
  return { csrf: session.csrfToken, sessionId: session.id }
}
