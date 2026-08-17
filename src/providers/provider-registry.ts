import { randomBytes } from 'node:crypto'
import { SecretCipherError, type SecretCipher } from '../crypto/index.ts'
import type {
  ProviderCapabilities,
  Database,
  KeyProbeVerdict,
  ProviderRecord,
  ProviderRepository,
  ProviderStaticHeader,
  UpstreamAccountRecord,
  UpstreamKeyHealth,
  UpstreamKeyPatch,
  UpstreamKeyRecord,
} from '../persistence/index.ts'
import type { InferenceAdapter, InferenceFailureClassification } from '../inference/index.ts'
import { systemClock, type Clock } from '../runtime/clock.ts'
import type { UsageRecoveryEvidence } from '../usage/adapter.ts'
import type { AdapterRegistry } from './adapter-registry.ts'
import type { UpstreamKeyProbe } from './key-probe.ts'
import { RoundRobinSelector } from './round-robin.ts'
import { reconcileCapacity } from './capacity-reconciliation.ts'
import type { CapacityEvidence, CredentialEvidence } from './provider-evidence.ts'
import { GENERIC_PROVIDER_TEMPLATE_ID, type ProviderTemplate, type ProviderWireFormat } from './templates.ts'
import { normalizeLogoDomainInput } from '../brand-logos/index.ts'

export interface FieldProblem {
  readonly field: string
  readonly message: string
}

export type ProviderFailure =
  | { readonly code: 'provider_not_found' }
  | { readonly code: 'key_not_found' }
  | { readonly code: 'account_not_found' }
  /** The connection is archived; only duplication and purge still apply to it. */
  | { readonly code: 'provider_archived' }
  /** The Owner has disabled the connection; it serves no inference. */
  | { readonly code: 'provider_disabled' }
  /** No Upstream Key on the connection is currently eligible to serve. */
  | { readonly code: 'no_eligible_key' }
  /** Purge is archive-first: only an archived connection can be purged. */
  | { readonly code: 'not_archived' }
  /** Encrypted material could not be read; the master key likely changed. */
  | { readonly code: 'stored_key_unreadable' }
  | { readonly code: 'handle_already_exists'; readonly problems: readonly FieldProblem[] }
  | { readonly code: 'validation_failed'; readonly problems: readonly FieldProblem[] }

export type ProviderResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ProviderFailure }

/**
 * The per-entry verdict of a bulk import. Successful entries carry the new
 * key id at its original batch position; failed entries carry the field
 * problems the same way the single-row form would have surfaced them.
 */
export interface BulkAddKeysResult {
  readonly added: readonly { readonly index: number; readonly keyId: string }[]
  readonly failed: readonly { readonly index: number; readonly problems: readonly FieldProblem[] }[]
}

/** What the Owner may see about an Upstream Key. Never the key itself. */
export interface KeyView {
  readonly id: string
  readonly health: UpstreamKeyHealth
  /** The Key's own base URL override; null means inherit the Provider's default. */
  readonly baseUrl: string | null
  /**
   * The base URL one upstream call should hit. The Key's own override wins when
   * set; otherwise this is the Provider's default. The UI never has to compute
   * the inheritance — the registry does it once and reports the result.
   */
  readonly effectiveBaseUrl: string
  readonly lastProbe: {
    readonly at: Date
    readonly verdict: KeyProbeVerdict
    readonly reason: string | null
  } | null
  readonly healthReason: string | null
  readonly healthChangedAt: Date
  readonly retryAfterAt: Date | null
  readonly healthScope: UpstreamKeyRecord['healthScope']
  readonly healthScopeId: string | null
  readonly healthModel: string | null
  /** The account the key shares billing or capacity with, or null when independent. */
  readonly accountId: string | null
  /** Exact models the key may serve; null means every connection model. */
  readonly allowedModels: readonly string[] | null
  /** Exact models the key never serves; null means nothing is excluded. */
  readonly deniedModels: readonly string[] | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** What the Owner may see about an Upstream Account. */
export interface UpstreamAccountView {
  readonly id: string
  readonly displayName: string
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** What one provider-scoped inference call needs, ready for an Inference Adapter. */
export interface InferenceTarget {
  readonly keyId: string
  readonly accountId: string | null
  readonly baseUrl: string
  readonly allowInsecureHttp: boolean
  readonly retryMaxAttempts: number
  readonly retryAmbiguousNetwork: boolean
  /** The decrypted Upstream Key; it exists only for the duration of the call. */
  readonly upstreamKey: string
  /** Canonical authentication header name. */
  readonly authHeader: string
  /** Plain-text authentication header prefix; "" means none. */
  readonly authPrefix: string
  /** Decrypted static headers merged into every upstream request. */
  readonly staticHeaders: Readonly<Record<string, string>>
  /** Whether same-origin redirects are explicitly allowed. */
  readonly redirectAllowSameOrigin: boolean
  /** Idempotency header name the adapter accepts. */
  readonly idempotencyHeader: string
  /** Per-connection override for the connection timeout (ms). */
  readonly connectionTimeoutMs: number
  /** Per-connection override for the first-byte timeout (ms). */
  readonly firstByteTimeoutMs: number
  /** Per-connection override for the non-streaming total timeout (ms). */
  readonly nonStreamingTotalTimeoutMs: number
  /** Per-connection override for the streaming idle timeout (ms). */
  readonly streamingIdleTimeoutMs: number
  /** Per-connection override for the total-retry timeout (ms). */
  readonly totalRetryTimeoutMs: number
}

export interface ProviderView {
  readonly id: string
  readonly handle: string
  readonly displayName: string
  readonly baseUrl: string
  readonly logoDomain: string | null
  readonly allowInsecureHttp: boolean
  readonly enabled: boolean
  readonly retryMaxAttempts: number
  readonly retryAmbiguousNetwork: boolean
  readonly archived: boolean
  /**
   * The Provider Template whose defaults seeded this connection, or null
   * when the Owner built it by hand. The id is stable and matches the
   * Adapter Registry's template list exactly.
   */
  readonly templateId: string | null
  readonly authHeader: string
  readonly authPrefix: string
  /** Static header names only; the values stay encrypted at rest. */
  readonly staticHeaders: readonly { readonly name: string }[]
  readonly redirectAllowSameOrigin: boolean
  readonly connectionTimeoutMs: number
  readonly firstByteTimeoutMs: number
  readonly nonStreamingTotalTimeoutMs: number
  readonly streamingIdleTimeoutMs: number
  readonly totalRetryTimeoutMs: number
  readonly idempotencyHeader: string
  /** Persistent warnings the Owner UI renders (e.g. "insecure_http"). */
  readonly warnings: readonly string[]
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly keys: readonly KeyView[]
  readonly accounts: readonly UpstreamAccountView[]
}

/**
 * What one Request needs to know about a Provider once, before an Upstream Key
 * is selected: which Inference Adapter speaks for it, the wire shape its
 * upstream speaks, its retry settings, and the Provider Template id that seeded
 * it. Produced by {@link ProviderRegistry.resolveProvider} so the inference and
 * entitlement paths cannot disagree about a Provider's adapters.
 *
 * This is implementation, not domain language, and deliberately absent from the
 * glossary — its shape is free to change and no test should assert it.
 */
export interface ResolvedProvider {
  /** The Provider Template that seeded the connection, or null when built by hand. */
  readonly templateId: string | null
  /** The body shape the upstream speaks; `openai` for a template-less Provider. */
  readonly wireFormat: ProviderWireFormat
  /**
   * The Inference Adapter that speaks for this Provider. Null only when the
   * Adapter Registry carries no generic adapter to fall back to, which a
   * built-in registry never does.
   */
  readonly inferenceAdapter: InferenceAdapter | null
  readonly retryMaxAttempts: number
  readonly retryAmbiguousNetwork: boolean
  readonly totalRetryTimeoutMs: number
}

export interface ProviderRegistryOptions {
  readonly database: Database
  readonly cipher: SecretCipher
  readonly keyProbe: UpstreamKeyProbe
  /**
   * The Adapter Registry the registry consults when an Owner submits a
   * `templateId`. Required: a connection created from a template cannot be
   * validated without the registry, and a registry missing the templates the
   * built-in set promises would silently drop Owner-supplied IDs.
   */
  readonly adapterRegistry: AdapterRegistry
  readonly clock?: Clock
}

const DISPLAY_NAME_MAXIMUM = 128
const PROVIDER_HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const BASE_URL_MAXIMUM = 2048
const UPSTREAM_KEY_MAXIMUM = 2048
const AUTH_HEADER_MAXIMUM = 128
const AUTH_PREFIX_MAXIMUM = 64
const STATIC_HEADER_VALUE_MAXIMUM = 4096
const STATIC_HEADER_MAXIMUM_ENTRIES = 50
const TIMEOUT_MINIMUM_MS = 1_000
const TIMEOUT_MAXIMUM_MS = 600_000
const STATIC_HEADERS_BLANK = '[]'

/**
 * How many Upstream Keys one probe pass tests at the same time.
 *
 * Sequential probing made every mutation that adds a key pay one upstream round
 * trip per unverified key already on the Provider, so a bulk import of forty
 * cost forty. Unbounded probing is not the cure: forty simultaneous
 * authentication attempts against the very upstream being tested invite a 429
 * and would record forty valid keys as rate-limited. Five is small enough to
 * look like ordinary traffic and wide enough that an import is bounded by
 * ceil(n / 5) round trips instead of n.
 */
const PROBE_CONCURRENCY = 5

/**
 * Header names Iroha treats as safe without further validation: the canonical
 * OpenAI-compatible header shapes, plus the OpenRouter / Anthropic-style
 * aliases. Anything outside this list passes only when it matches the
 * `custom-name` regex applied in `authHeaderProblems`.
 */
const APPROVED_AUTH_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'api-key',
])

/**
 * What Iroha knows about configuring Providers.
 *
 * The rules that matter live here rather than in the HTTP layer: IDs never
 * change, keys are stored before they are tested, an inconclusive test keeps
 * its reason instead of discarding the secret, secret material is encrypted on
 * the way in and never leaves again, and archive stands between a Provider
 * and its purge.
 */
export class ProviderRegistry {
  readonly #database: Database
  readonly #cipher: SecretCipher
  readonly #probe: UpstreamKeyProbe
  readonly #clock: Clock
  readonly #adapterRegistry: AdapterRegistry
  /**
   * The volatile round-robin cursor. It is deliberately not persisted: it only
   * spreads consecutive selections evenly, and a restart that resets it changes
   * nothing durable.
   */
  readonly #selector: RoundRobinSelector
  readonly #controlledTrials = new Set<string>()

  constructor(options: ProviderRegistryOptions) {
    this.#database = options.database
    this.#cipher = options.cipher
    this.#probe = options.keyProbe
    this.#clock = options.clock ?? systemClock
    this.#adapterRegistry = options.adapterRegistry
    this.#selector = new RoundRobinSelector()
  }

  /** Resolve a public Handle once at the inference boundary; all later policy remains ID-based. */
  async resolveHandle(handle: string): Promise<
    | { readonly ok: true; readonly providerId: string; readonly providerHandle: string }
    | { readonly ok: false; readonly code: 'invalid_provider_handle' | 'provider_not_allowed' }
  > {
    if (!isProviderHandle(handle)) {
      return { ok: false, code: 'invalid_provider_handle' }
    }

    const provider = await this.#database.providers.getProviderByHandle(handle)
    if (provider === null || provider.archivedAt !== null || !provider.enabled) {
      return { ok: false, code: 'provider_not_allowed' }
    }
    return { ok: true, providerId: provider.id, providerHandle: provider.handle }
  }

  async checkHandleAvailability(handle: string): Promise<{ readonly available: boolean; readonly suggestion: string | null }> {
    const existing = await this.#database.providers.getProviderByHandle(handle)
    if (existing === null) return { available: true, suggestion: null }
    const used = new Set((await this.#database.providers.listProviders()).map((provider) => provider.handle))
    return { available: false, suggestion: suggestAvailableProviderHandle(handle, used) }
  }

  /** Every connection, archived ones included, most recently created first. */
  async listProviders(): Promise<readonly ProviderView[]> {
    const connections = await this.#database.providers.listProviders()

    return await Promise.all(
      connections.map(async (connection) => ({
        ...(await this.#viewOf(connection.id)),
      })),
    )
  }

  async getProvider(id: string): Promise<ProviderView | null> {
    const connection = await this.#database.providers.getProvider(id)
    if (connection === null) return null
    return await this.#viewOf(id)
  }

  /**
   * Resolves a Provider once per Request, before an Upstream Key is selected,
   * into the Inference Adapter that speaks for it, the wire shape its upstream
   * speaks, and its retry settings. Both the inference path and the entitlement
   * polling path resolve a Provider's adapters through the Adapter Registry's
   * one resolution, so no two callers can disagree about which adapter a
   * Provider uses. Returns null when no such Provider exists.
   */
  async resolveProvider(id: string): Promise<ResolvedProvider | null> {
    const view = await this.getProvider(id)
    if (view === null) return null
    return {
      templateId: view.templateId,
      wireFormat: this.#adapterRegistry.resolveWireFormat(view.templateId),
      inferenceAdapter: this.#adapterRegistry.resolveInferenceAdapter(view.templateId),
      retryMaxAttempts: view.retryMaxAttempts,
      retryAmbiguousNetwork: view.retryAmbiguousNetwork,
      totalRetryTimeoutMs: view.totalRetryTimeoutMs,
    }
  }

  /**
   * Creates a connection with one or more Upstream Keys. Each key is stored
   * encrypted and Unverified first, then tested; a usable test activates it,
   * anything else keeps the key and records why. The keys may each carry an
   * optional per-key base URL override; when omitted the key inherits the
   * Provider's default URL. Round-robin then naturally spreads across the
   * Provider's keys, and each key uses the URL it was bound to.
   *
   * When `templateId` is supplied, the Adapter Registry looks it up and
   * prefills safe endpoint, authentication, and capability defaults. The
   * Owner may override every field; the template only seeds defaults and is
   * recorded on the connection so the UI can show where the defaults came
   * from. An unknown template id is a validation error, never a silent
   * fallback. When `templateId` is omitted (or null), the Generic
   * OpenAI-compatible template is used, so a bare create still records the
   * safe defaults it seeded; a registry that lacks that template falls back
   * to the hand-configured defaults.
   */
  async create(input: {
    handle?: unknown
    displayName: unknown
    baseUrl: unknown
    logoDomain?: unknown
    keys: unknown
    /**
     * Provider Template id, or null/omitted to seed the Generic
     * OpenAI-compatible default.
     */
    templateId?: unknown
    allowInsecureHttp?: unknown
    authHeader?: unknown
    authPrefix?: unknown
    staticHeaders?: unknown
    redirectAllowSameOrigin?: unknown
    connectionTimeoutMs?: unknown
    firstByteTimeoutMs?: unknown
    nonStreamingTotalTimeoutMs?: unknown
    streamingIdleTimeoutMs?: unknown
    totalRetryTimeoutMs?: unknown
    idempotencyHeader?: unknown
  }): Promise<ProviderResult<ProviderView>> {
    const allowInsecureHttp = input.allowInsecureHttp === true

    const authHeader = input.authHeader === undefined ? 'authorization' : input.authHeader
    const authPrefix = input.authPrefix === undefined ? 'Bearer ' : input.authPrefix
    const idempotencyHeader = input.idempotencyHeader === undefined
      ? 'Idempotency-Key'
      : (input.idempotencyHeader as string)
    const redirectAllowSameOrigin = input.redirectAllowSameOrigin === true

    const problems: FieldProblem[] = []
    problems.push(...providerHandleProblems(input.handle))
    problems.push(...displayNameProblems(input.displayName))
    problems.push(...baseUrlProblems(input.baseUrl, allowInsecureHttp))
    // Per-Key URL overrides need the Provider's base URL for http-vs-https
    // inheritance; only thread it through when the Provider URL itself was
    // parseable so a malformed Provider URL does not produce cascading
    // per-key errors before the early-return below catches it.
    const providerBaseUrlForKeyInheritance = typeof input.baseUrl === 'string'
      ? input.baseUrl.trim()
      : ''
    const keyInputs = readCreateKeys(input.keys, providerBaseUrlForKeyInheritance, problems)
    problems.push(...authHeaderProblems(authHeader))
    problems.push(...authPrefixProblems(authPrefix))
    problems.push(...idempotencyHeaderProblems(idempotencyHeader))
    problems.push(...timeoutProblems('connectionTimeoutMs', input.connectionTimeoutMs))
    problems.push(...timeoutProblems('firstByteTimeoutMs', input.firstByteTimeoutMs))
    problems.push(...timeoutProblems('nonStreamingTotalTimeoutMs', input.nonStreamingTotalTimeoutMs))
    problems.push(...timeoutProblems('streamingIdleTimeoutMs', input.streamingIdleTimeoutMs))
    problems.push(...timeoutProblems('totalRetryTimeoutMs', input.totalRetryTimeoutMs))

    const staticHeadersResult = readStaticHeaders(input.staticHeaders, problems)
    if (problems.length > 0) return failed({ code: 'validation_failed', problems })

    // No template named seeds the Generic OpenAI-compatible default so a bare
    // create still records where its safe defaults came from. A registry that
    // omits the generic template (a custom/embedded build) falls back to
    // hand-configured defaults below.
    let template: ProviderTemplate | null =
      this.#adapterRegistry.providerTemplate(GENERIC_PROVIDER_TEMPLATE_ID)
    if (input.templateId !== undefined && input.templateId !== null) {
      if (typeof input.templateId !== 'string' || input.templateId.trim() === '') {
        problems.push({ field: 'templateId', message: 'must be a known Provider Template id or null' })
      } else {
        const chosen = this.#adapterRegistry.providerTemplate(input.templateId.trim())
        if (chosen === null) {
          problems.push({ field: 'templateId', message: 'must be a known Provider Template id or null' })
        } else {
          template = chosen
        }
      }
    }
    if (problems.length > 0) return failed({ code: 'validation_failed', problems })

    const displayName = (input.displayName as string).trim()
    const handle = input.handle as string
    const baseUrl = (input.baseUrl as string).trim()
    let logoDomain: string | null
    if (input.logoDomain === undefined) {
      logoDomain = template?.brand?.domain ?? logoDomainFromBaseUrl(baseUrl)
    } else {
      const read = readLogoDomainInput(input.logoDomain)
      if (!read.ok) return failed({ code: 'validation_failed', problems: [read.problem] })
      logoDomain = read.value
    }
    const authHeaderName = (input.authHeader === undefined && template !== null
      ? template.authHeader
      : (authHeader as string).trim())
    const authPrefixValue = input.authPrefix === undefined && template !== null
      ? template.authPrefix
      : (authPrefix as string)
    const idempotencyHeaderName = input.idempotencyHeader === undefined
      ? 'Idempotency-Key'
      : (idempotencyHeader as string).trim()
    const connectionTimeoutMs = numericDefault(input.connectionTimeoutMs, 10_000)
    const firstByteTimeoutMs = numericDefault(input.firstByteTimeoutMs, 20_000)
    const nonStreamingTotalTimeoutMs = numericDefault(input.nonStreamingTotalTimeoutMs, 120_000)
    const streamingIdleTimeoutMs = numericDefault(input.streamingIdleTimeoutMs, 30_000)
    const totalRetryTimeoutMs = numericDefault(input.totalRetryTimeoutMs, 30_000)

    const staticHeadersEncrypted = await this.#encryptStaticHeaders(staticHeadersResult)
    const at = this.#clock.now()
    const providerId = newId('pr')
    const capabilities: ProviderCapabilities = template !== null
      ? { ...template.capabilities }
      : defaultCapabilities()

    // Encrypt every key up front so the database transaction only performs
    // plain inserts and the row state stays consistent on a probe failure.
    const preparedKeys = await Promise.all(
      keyInputs.map(async (key) => ({
        id: newId('uk'),
        providerId,
        baseUrl: key.baseUrl,
        accountId: null,
        encryptedKey: await this.#cipher.encrypt(key.upstreamKey),
        health: 'unverified' as const,
        lastProbeAt: null,
        lastProbeVerdict: null,
        lastProbeReason: null,
        healthReason: null,
        healthChangedAt: at,
        retryAfterAt: null,
        healthScope: 'key' as const,
        healthScopeId: null,
        healthModel: null,
        allowedModels: null,
        deniedModels: null,
        createdAt: at,
        updatedAt: at,
      })),
    )

    try {
    await this.#database.transaction(async (repositories) => {
      await repositories.providers.insertProvider({
        id: providerId,
        handle,
        displayName,
        baseUrl,
        logoDomain,
        allowInsecureHttp,
        enabled: true,
        retryMaxAttempts: 3,
        retryAmbiguousNetwork: false,
        archivedAt: null,
        templateId: template?.id ?? null,
        capabilities,
        authHeader: authHeaderName,
        authPrefix: authPrefixValue,
        staticHeadersEncrypted,
        redirectAllowSameOrigin,
        connectionTimeoutMs,
        firstByteTimeoutMs,
        nonStreamingTotalTimeoutMs,
        streamingIdleTimeoutMs,
        totalRetryTimeoutMs,
        idempotencyHeader: idempotencyHeaderName,
        createdAt: at,
        updatedAt: at,
      })
      for (const key of preparedKeys) {
        await repositories.providers.insertKey(key)
      }
      await repositories.audit.record({
        action: 'provider.created',
        outcome: 'success',
        detail: { providerId, displayName, keyCount: preparedKeys.length },
        at,
      })
      for (const key of preparedKeys) {
        await repositories.audit.record({
          action: 'key.created',
          outcome: 'success',
          detail: {
            providerId,
            keyId: key.id,
            ...(key.baseUrl !== null ? { baseUrlInherited: false } : {}),
          },
          at,
        })
      }
    })

    } catch (cause) {
      if (isUniqueConstraintFailure(cause)) {
        return failed({ code: 'handle_already_exists', problems: [{ field: 'handle', message: 'is already in use' }] })
      }
      throw cause
    }

    await this.#probeConnectionKeys(providerId)

    const created = await this.getProvider(providerId)
    return created === null ? failed({ code: 'provider_not_found' }) : { ok: true, value: created }
  }

  /** Edits the editable fields of a live connection. The ID never moves. */
  async update(
    id: string,
    patch: {
      displayName?: unknown
      baseUrl?: unknown
      logoDomain?: unknown
      allowInsecureHttp?: unknown
      enabled?: unknown
      retryMaxAttempts?: unknown
      retryAmbiguousNetwork?: unknown
      authHeader?: unknown
      authPrefix?: unknown
      staticHeaders?: unknown
      redirectAllowSameOrigin?: unknown
      connectionTimeoutMs?: unknown
      firstByteTimeoutMs?: unknown
      nonStreamingTotalTimeoutMs?: unknown
      streamingIdleTimeoutMs?: unknown
      totalRetryTimeoutMs?: unknown
      idempotencyHeader?: unknown
    },
  ): Promise<ProviderResult<ProviderView>> {
    const connection = await this.#database.providers.getProvider(id)
    if (connection === null) return failed({ code: 'provider_not_found' })
    if (connection.archivedAt !== null) return failed({ code: 'provider_archived' })

    const changes: {
      displayName?: string
      baseUrl?: string
      logoDomain?: string | null
      allowInsecureHttp?: boolean
      enabled?: boolean
      retryMaxAttempts?: number
      retryAmbiguousNetwork?: boolean
      authHeader?: string
      authPrefix?: string
      staticHeadersEncrypted?: string
      redirectAllowSameOrigin?: boolean
      connectionTimeoutMs?: number
      firstByteTimeoutMs?: number
      nonStreamingTotalTimeoutMs?: number
      streamingIdleTimeoutMs?: number
      totalRetryTimeoutMs?: number
      idempotencyHeader?: string
    } = {}

    if (patch.displayName !== undefined) {
      const problems = displayNameProblems(patch.displayName)
      if (problems.length > 0) return failed({ code: 'validation_failed', problems })
      changes.displayName = (patch.displayName as string).trim()
    }

    if (patch.allowInsecureHttp !== undefined) {
      changes.allowInsecureHttp = patch.allowInsecureHttp === true
    }

    if (patch.baseUrl !== undefined) {
      const problems = baseUrlProblems(
        patch.baseUrl,
        changes.allowInsecureHttp ?? connection.allowInsecureHttp,
      )
      if (problems.length > 0) return failed({ code: 'validation_failed', problems })
      changes.baseUrl = (patch.baseUrl as string).trim()
    }

    if (patch.logoDomain !== undefined) {
      const read = readLogoDomainInput(patch.logoDomain)
      if (!read.ok) return failed({ code: 'validation_failed', problems: [read.problem] })
      changes.logoDomain = read.value
    } else if (
      changes.baseUrl !== undefined &&
      connection.templateId === GENERIC_PROVIDER_TEMPLATE_ID &&
      connection.logoDomain === logoDomainFromBaseUrl(connection.baseUrl)
    ) {
      changes.logoDomain = logoDomainFromBaseUrl(changes.baseUrl)
    }

    if (patch.enabled !== undefined) {
      changes.enabled = patch.enabled === true
    }

    if (patch.retryMaxAttempts !== undefined) {
      if (
        typeof patch.retryMaxAttempts !== 'number' ||
        !Number.isInteger(patch.retryMaxAttempts) ||
        patch.retryMaxAttempts < 1 ||
        patch.retryMaxAttempts > 5
      ) {
        return failed({
          code: 'validation_failed',
          problems: [{ field: 'retryMaxAttempts', message: 'must be an integer from 1 to 5' }],
        })
      }
      changes.retryMaxAttempts = patch.retryMaxAttempts
    }

    if (patch.retryAmbiguousNetwork !== undefined) {
      changes.retryAmbiguousNetwork = patch.retryAmbiguousNetwork === true
    }

    const advancedProblems: FieldProblem[] = []
    if (patch.authHeader !== undefined) {
      advancedProblems.push(...authHeaderProblems(patch.authHeader))
      changes.authHeader = (patch.authHeader as string).trim()
    }
    if (patch.authPrefix !== undefined) {
      advancedProblems.push(...authPrefixProblems(patch.authPrefix))
      changes.authPrefix = patch.authPrefix as string
    }
    if (patch.idempotencyHeader !== undefined) {
      advancedProblems.push(...idempotencyHeaderProblems(patch.idempotencyHeader))
      changes.idempotencyHeader = (patch.idempotencyHeader as string).trim()
    }
    if (patch.redirectAllowSameOrigin !== undefined) {
      changes.redirectAllowSameOrigin = patch.redirectAllowSameOrigin === true
    }
    if (patch.connectionTimeoutMs !== undefined) {
      advancedProblems.push(...timeoutProblems('connectionTimeoutMs', patch.connectionTimeoutMs))
      changes.connectionTimeoutMs = numericDefault(patch.connectionTimeoutMs, connection.connectionTimeoutMs)
    }
    if (patch.firstByteTimeoutMs !== undefined) {
      advancedProblems.push(...timeoutProblems('firstByteTimeoutMs', patch.firstByteTimeoutMs))
      changes.firstByteTimeoutMs = numericDefault(patch.firstByteTimeoutMs, connection.firstByteTimeoutMs)
    }
    if (patch.nonStreamingTotalTimeoutMs !== undefined) {
      advancedProblems.push(
        ...timeoutProblems('nonStreamingTotalTimeoutMs', patch.nonStreamingTotalTimeoutMs),
      )
      changes.nonStreamingTotalTimeoutMs = numericDefault(
        patch.nonStreamingTotalTimeoutMs,
        connection.nonStreamingTotalTimeoutMs,
      )
    }
    if (patch.streamingIdleTimeoutMs !== undefined) {
      advancedProblems.push(...timeoutProblems('streamingIdleTimeoutMs', patch.streamingIdleTimeoutMs))
      changes.streamingIdleTimeoutMs = numericDefault(
        patch.streamingIdleTimeoutMs,
        connection.streamingIdleTimeoutMs,
      )
    }
    if (patch.totalRetryTimeoutMs !== undefined) {
      advancedProblems.push(...timeoutProblems('totalRetryTimeoutMs', patch.totalRetryTimeoutMs))
      changes.totalRetryTimeoutMs = numericDefault(
        patch.totalRetryTimeoutMs,
        connection.totalRetryTimeoutMs,
      )
    }
    let newStaticHeaders: readonly ProviderStaticHeader[] | null = null
    if (patch.staticHeaders !== undefined) {
      const read = readStaticHeaders(patch.staticHeaders, advancedProblems)
      newStaticHeaders = read
    }
    if (advancedProblems.length > 0) return failed({ code: 'validation_failed', problems: advancedProblems })

    if (changes.baseUrl === undefined && changes.allowInsecureHttp !== undefined) {
      // The flag changed under an unchanged URL: an https URL ignores the
      // flag, but an http URL must not lose its exception.
      if (new URL(connection.baseUrl).protocol === 'http:' && changes.allowInsecureHttp === false) {
        return failed({
          code: 'validation_failed',
          problems: [
            {
              field: 'allowInsecureHttp',
              message: 'cannot be withdrawn while the base URL still uses plain HTTP',
            },
          ],
        })
      }
    }

    if (newStaticHeaders !== null) {
      changes.staticHeadersEncrypted = await this.#encryptStaticHeaders(newStaticHeaders)
    }

    if (Object.keys(changes).length === 0) {
      return { ok: true, value: await this.#viewOf(connection.id) }
    }

    const at = this.#clock.now()
    await this.#database.transaction(async (repositories) => {
      await repositories.providers.updateProvider(id, changes, at)
      await repositories.audit.record({
        action: 'provider.updated',
        outcome: 'success',
        // Field names only: a base URL may carry as much secret as a key.
        detail: { providerId: id, fields: Object.keys(changes) },
        at,
      })
    })

    return { ok: true, value: await this.#viewOf(id) }
  }

  /** Archiving preserves the connection's identity and takes it out of use. */
  async archive(id: string): Promise<ProviderResult<ProviderView>> {
    const connection = await this.#database.providers.getProvider(id)
    if (connection === null) return failed({ code: 'provider_not_found' })

    if (connection.archivedAt === null) {
      const at = this.#clock.now()
      await this.#database.transaction(async (repositories) => {
        await repositories.providers.updateProvider(id, { enabled: false, archivedAt: at }, at)
        await repositories.audit.record({
          action: 'provider.archived',
          outcome: 'success',
          detail: { providerId: id },
          at,
        })
      })
    }

    return { ok: true, value: await this.#viewOf(id) }
  }

  /** Restores an archived Provider and returns it to owner-enabled routing. */
  async restore(id: string): Promise<ProviderResult<ProviderView>> {
    const provider = await this.#database.providers.getProvider(id)
    if (provider === null) return failed({ code: 'provider_not_found' })

    if (provider.archivedAt !== null) {
      const at = this.#clock.now()
      await this.#database.transaction(async (repositories) => {
        await repositories.providers.updateProvider(id, { enabled: true, archivedAt: null }, at)
        await repositories.audit.record({
          action: 'provider.restored',
          outcome: 'success',
          detail: { providerId: id },
          at,
        })
      })
    }

    return { ok: true, value: await this.#viewOf(id) }
  }

  /**
   * Copies a connection under a brand-new identity. Keys are decrypted only
   * long enough to be re-encrypted, start Unverified again, and are tested
   * like the originals.
   */
  async duplicate(id: string, handleInput: unknown): Promise<ProviderResult<ProviderView>> {
    const source = await this.#database.providers.getProvider(id)
    if (source === null) return failed({ code: 'provider_not_found' })

    const problems = providerHandleProblems(handleInput)
    if (problems.length > 0) return failed({ code: 'validation_failed', problems })
    const handle = handleInput as string

    const sourceKeys = await this.#database.providers.listKeys(id)
    const at = this.#clock.now()
    const providerId = newId('pr')
    const material: { keyId: string; plaintext: string }[] = []
    try {
      for (const key of sourceKeys) {
        material.push({ keyId: newId('uk'), plaintext: await this.#cipher.decrypt(key.encryptedKey) })
      }
    } catch (cause) {
      if (cause instanceof SecretCipherError) return failed({ code: 'stored_key_unreadable' })
      throw cause
    }

    try {
    await this.#database.transaction(async (repositories) => {
      await repositories.providers.insertProvider({
        id: providerId,
        handle,
        displayName: copiedName(source.displayName),
        baseUrl: source.baseUrl,
        logoDomain: source.logoDomain,
        allowInsecureHttp: source.allowInsecureHttp,
        enabled: true,
        retryMaxAttempts: source.retryMaxAttempts,
        retryAmbiguousNetwork: source.retryAmbiguousNetwork,
        archivedAt: null,
        templateId: source.templateId,
        capabilities: source.capabilities,
        authHeader: source.authHeader,
        authPrefix: source.authPrefix,
        staticHeadersEncrypted: source.staticHeadersEncrypted,
        redirectAllowSameOrigin: source.redirectAllowSameOrigin,
        connectionTimeoutMs: source.connectionTimeoutMs,
        firstByteTimeoutMs: source.firstByteTimeoutMs,
        nonStreamingTotalTimeoutMs: source.nonStreamingTotalTimeoutMs,
        streamingIdleTimeoutMs: source.streamingIdleTimeoutMs,
        totalRetryTimeoutMs: source.totalRetryTimeoutMs,
        idempotencyHeader: source.idempotencyHeader,
        createdAt: at,
        updatedAt: at,
      })

      for (const copied of material) {
        await repositories.providers.insertKey({
          id: copied.keyId,
          providerId,
        baseUrl: null,
        accountId: null,
          encryptedKey: await this.#cipher.encrypt(copied.plaintext),
          health: 'unverified',
          lastProbeAt: null,
          lastProbeVerdict: null,
          lastProbeReason: null,
          healthReason: null,
          healthChangedAt: at,
          retryAfterAt: null,
          healthScope: 'key',
          healthScopeId: null,
          healthModel: null,
          allowedModels: null,
          deniedModels: null,
          createdAt: at,
          updatedAt: at,
        })
      }

      await repositories.audit.record({
        action: 'provider.duplicated',
        outcome: 'success',
        detail: { providerId, sourceId: id },
        at,
      })
    })
    } catch (cause) {
      if (isUniqueConstraintFailure(cause)) {
        return failed({ code: 'handle_already_exists', problems: [{ field: 'handle', message: 'is already in use' }] })
      }
      throw cause
    }

    await this.#probeConnectionKeys(providerId)

    return { ok: true, value: await this.#viewOf(providerId) }
  }

  /**
   * Removes a connection and its keys permanently. Nothing is restorable, so
   * deletion is archive-first: only a connection already taken out of active
   * use can be purged.
   */
  async purge(id: string): Promise<ProviderResult<boolean>> {
    const connection = await this.#database.providers.getProvider(id)
    if (connection === null) return failed({ code: 'provider_not_found' })
    if (connection.archivedAt === null) return failed({ code: 'not_archived' })

    const at = this.#clock.now()
    await this.#database.transaction(async (repositories) => {
      await repositories.providers.deleteKeysForProvider(id)
      await repositories.providers.deleteProvider(id)
      await repositories.audit.record({
        action: 'provider.purged',
        outcome: 'success',
        detail: { providerId: id, displayName: connection.displayName },
        at,
      })
    })

    return { ok: true, value: true }
  }

  /** Runs the key test on demand and records what it learned. */
  async testKey(providerId: string, keyId: string): Promise<ProviderResult<ProviderView>> {
    const located = await this.#locateKey(providerId, keyId)
    if (!located.ok) return located

    const { connection, key } = located.value
    // The manual test must hit the URL the key will actually use at inference
    // time — a key with its own override URL is meaningless if its health
    // verdict was earned against a different endpoint. Mirrors the inheritance
    // the probe pass and inference resolution both use.
    const probe = await this.#runProbe(key.baseUrl ?? connection.baseUrl, key.encryptedKey)
    if (!probe.readable) return failed({ code: 'stored_key_unreadable' })

    const at = this.#clock.now()
    // The probe verdict is the source of truth for the post-test health.
    // A disabled key stays disabled: a test informs, only activation revives.
    // For every other key, `usable` activates, `rejected` demotes to
    // invalid_authentication, and `inconclusive` demotes to cooling_down —
    // so the badge and any inline verdict always agree.
    const patch = probedPatch(key, probe, at)
    await this.#database.transaction(async (repositories) => {
      await repositories.providers.updateKey(keyId, patch, at)
      await repositories.audit.record({
        action: 'key.tested',
        outcome: probe.verdict === 'authenticated' ? 'success' : 'failure',
        detail: {
          providerId,
          keyId,
          verdict: probe.verdict,
          reason: probe.reason,
          previousHealth: key.health,
          ...(patch.health === undefined ? {} : { newHealth: patch.health }),
        },
        at,
      })
    })
    this.#controlledTrials.delete(healthClaim(key))
    return { ok: true, value: await this.#viewOf(providerId) }
  }

  /**
   * Decrypts one Upstream Key on demand and records the reveal in the audit
   * log. The DB at rest stays encrypted; the plaintext exists only in the
   * response and the Owner's browser session after they ask. Each reveal
   * leaves an audit trail entry so a stolen admin session can be detected.
   */
  async revealKey(
    providerId: string,
    keyId: string,
  ): Promise<ProviderResult<{ readonly value: string }>> {
    const located = await this.#locateKey(providerId, keyId)
    if (!located.ok) return located

    const { key } = located.value
    const at = this.#clock.now()
    let value: string
    try {
      value = await this.#cipher.decrypt(key.encryptedKey)
    } catch {
      await this.#database.audit.record({
        action: 'key.value.revealed',
        outcome: 'failure',
        detail: { providerId, keyId, reason: 'decryption_failed' },
        at,
      })
      return failed({ code: 'stored_key_unreadable' })
    }
    await this.#database.audit.record({
      action: 'key.value.revealed',
      outcome: 'success',
      detail: { providerId, keyId },
      at,
    })
    return { ok: true, value: { value } }
  }

  /** The Owner's explicit say-so that an untested or disabled key may be used. */
  async activateKey(providerId: string, keyId: string): Promise<ProviderResult<ProviderView>> {
    const located = await this.#locateKey(providerId, keyId)
    if (!located.ok) return located

    if (located.value.key.health !== 'active') {
      const at = this.#clock.now()
      await this.#database.transaction(async (repositories) => {
        await repositories.providers.updateKey(
          keyId,
          {
            health: 'active',
            healthReason: 'activated by Owner',
            healthChangedAt: at,
            retryAfterAt: null,
            healthScope: 'key',
            healthScopeId: null,
            healthModel: null,
          },
          at,
        )
        await repositories.audit.record({
          action: 'key.activated',
          outcome: 'success',
          detail: { providerId, keyId },
          at,
        })
      })
    }

    return { ok: true, value: await this.#viewOf(providerId) }
  }

  async disableKey(providerId: string, keyId: string): Promise<ProviderResult<ProviderView>> {
    const located = await this.#locateKey(providerId, keyId)
    if (!located.ok) return located

    if (located.value.key.health !== 'disabled') {
      const at = this.#clock.now()
      await this.#database.transaction(async (repositories) => {
        await repositories.providers.updateKey(
          keyId,
          {
            health: 'disabled',
            healthReason: 'disabled by Owner',
            healthChangedAt: at,
            retryAfterAt: null,
            healthScope: 'key',
            healthScopeId: keyId,
            healthModel: null,
          },
          at,
        )
        await repositories.audit.record({
          action: 'key.disabled',
          outcome: 'success',
          detail: { providerId, keyId },
          at,
        })
      })
    }

    return { ok: true, value: await this.#viewOf(providerId) }
  }

  /**
   * Adds another Upstream Key to a Provider. Like the first, it is stored
   * encrypted and Unverified, then tested; a usable test activates it. Adding
   * a key never disturbs the keys already there.
   */
  async addKey(
    providerId: string,
    input: {
      upstreamKey: unknown
      /**
       * Per-Key override of the Provider's base URL. A blank string is treated
       * as "no override" so the Owner UI can ship a prefilled empty field that
       * means the same thing as omitting it.
       */
      baseUrl?: unknown
      accountId?: unknown
      allowedModels?: unknown
      deniedModels?: unknown
    },
  ): Promise<ProviderResult<ProviderView>> {
    const connection = await this.#database.providers.getProvider(providerId)
    if (connection === null) return failed({ code: 'provider_not_found' })
    if (connection.archivedAt !== null) return failed({ code: 'provider_archived' })

    const upstreamProblems = upstreamKeyProblems(input.upstreamKey)
    const problems: FieldProblem[] = [...upstreamProblems]
    const baseUrl = readKeyBaseUrl(input.baseUrl, connection.baseUrl, problems)
    const settings = await readKeySettings(this.#database.providers, providerId, input, problems)
    if (problems.length > 0) return failed({ code: 'validation_failed', problems })

    const at = this.#clock.now()
    const keyId = newId('uk')
    await this.#database.transaction(async (repositories) => {
      await repositories.providers.insertKey({
        id: keyId,
        providerId,
        baseUrl,
        accountId: settings.accountId === undefined ? null : settings.accountId,
        encryptedKey: await this.#cipher.encrypt((input.upstreamKey as string).trim()),
        health: 'unverified',
        lastProbeAt: null,
        lastProbeVerdict: null,
        lastProbeReason: null,
        healthReason: null,
        healthChangedAt: at,
        retryAfterAt: null,
        healthScope: 'key',
        healthScopeId: null,
        healthModel: null,
        allowedModels: settings.allowedModels === undefined ? null : settings.allowedModels,
        deniedModels: settings.deniedModels === undefined ? null : settings.deniedModels,
        createdAt: at,
        updatedAt: at,
      })
      await repositories.audit.record({
        action: 'key.created',
        outcome: 'success',
        detail: {
          providerId,
          keyId,
          ...(baseUrl !== null ? { baseUrlInherited: false } : {}),
          ...(Object.keys(settings).length > 0 ? { configuredFields: Object.keys(settings) } : {}),
        },
        at,
      })
    })

    await this.#probeConnectionKeys(providerId)

    return { ok: true, value: await this.#viewOf(providerId) }
  }

  /**
   * Adds many Upstream Keys to a Provider in one pass. Each entry is stored
   * encrypted and Unverified in its own transaction, audited as `key.created`,
   * and per-entry validation failures are recorded without stopping the rest
   * of the batch — the Owner gets partial success so a single bad line never
   * costs the good ones next to it.
   *
   * Bulk-imported keys intentionally carry no per-key `accountId`,
   * `allowedModels`, or `deniedModels`: the Owner configures those selectively
   * through the existing Configure dialog after import. The base URL override
   * follows the same inheritance rules as `addKey`, and `baseUrlInherited: false`
   * is recorded on the audit only when the entry supplied its own URL.
   *
   * Probing happens once at the end — looping `addKey` would pay for a fresh
   * probe after every insert and turn a 200-key paste into 200 sequential
   * probes, which is the budget the spec asks us to avoid.
   */
  async bulkAddKeys(
    providerId: string,
    input: {
      keys: readonly { readonly upstreamKey?: unknown; readonly baseUrl?: unknown }[]
    },
  ): Promise<ProviderResult<BulkAddKeysResult>> {
    const connection = await this.#database.providers.getProvider(providerId)
    if (connection === null) return failed({ code: 'provider_not_found' })
    if (connection.archivedAt !== null) return failed({ code: 'provider_archived' })

    const added: { index: number; keyId: string }[] = []
    const failedEntries: { index: number; problems: readonly FieldProblem[] }[] = []

    for (let index = 0; index < input.keys.length; index += 1) {
      const entry = input.keys[index]
      const problems: FieldProblem[] = []

      if (entry === null || typeof entry !== 'object') {
        problems.push({ field: `keys[${index}]`, message: 'must be an Upstream Key object' })
        failedEntries.push({ index, problems })
        continue
      }

      problems.push(...upstreamKeyProblems(entry.upstreamKey))
      const baseUrl = readKeyBaseUrl(entry.baseUrl, connection.baseUrl, problems)
      if (problems.length > 0) {
        failedEntries.push({ index, problems })
        continue
      }

      const keyId = newId('uk')
      const at = this.#clock.now()
      await this.#database.transaction(async (repositories) => {
        await repositories.providers.insertKey({
          id: keyId,
          providerId,
          baseUrl,
          accountId: null,
          encryptedKey: await this.#cipher.encrypt((entry.upstreamKey as string).trim()),
          health: 'unverified',
          lastProbeAt: null,
          lastProbeVerdict: null,
          lastProbeReason: null,
          healthReason: null,
          healthChangedAt: at,
          retryAfterAt: null,
          healthScope: 'key',
          healthScopeId: null,
          healthModel: null,
          allowedModels: null,
          deniedModels: null,
          createdAt: at,
          updatedAt: at,
        })
        await repositories.audit.record({
          action: 'key.created',
          outcome: 'success',
          detail: {
            providerId,
            keyId,
            ...(baseUrl !== null ? { baseUrlInherited: false } : {}),
          },
          at,
        })
      })
      added.push({ index, keyId })
    }

    await this.#probeConnectionKeys(providerId)

    return { ok: true, value: { added, failed: failedEntries } }
  }

  /**
   * Removes one key permanently. The key's history goes with it; the other
   * keys and any accounts on the connection are untouched.
   */
  async removeKey(providerId: string, keyId: string): Promise<ProviderResult<ProviderView>> {
    const located = await this.#locateKey(providerId, keyId)
    if (!located.ok) return located

    const at = this.#clock.now()
    await this.#database.transaction(async (repositories) => {
      await repositories.providers.deleteKey(keyId)
      await repositories.audit.record({
        action: 'key.removed',
        outcome: 'success',
        detail: { providerId, keyId },
        at,
      })
    })

    return { ok: true, value: await this.#viewOf(providerId) }
  }

  /**
   * Changes what an Owner-editable key may serve: which account, if any, it
   * shares billing or capacity with, and which exact models it may or may not
   * serve. `null` lists mean no restriction; the ID is never patchable.
   */
  async updateKeySettings(
    providerId: string,
    keyId: string,
    patch: { accountId?: unknown; allowedModels?: unknown; deniedModels?: unknown; baseUrl?: unknown },
  ): Promise<ProviderResult<ProviderView>> {
    const located = await this.#locateKey(providerId, keyId)
    if (!located.ok) return located

    const problems: FieldProblem[] = []
    const settings = await readKeySettings(this.#database.providers, providerId, patch, problems)
    if (problems.length > 0) return failed({ code: 'validation_failed', problems })

    const baseUrl =
      patch.baseUrl === undefined
        ? undefined
        : readKeyBaseUrl(patch.baseUrl, located.value.connection.baseUrl, problems)
    if (problems.length > 0) return failed({ code: 'validation_failed', problems })

    const changes: {
      accountId?: string | null
      allowedModels?: readonly string[] | null
      deniedModels?: readonly string[] | null
      baseUrl?: string | null
    } = {}
    if (settings.accountId !== undefined) changes.accountId = settings.accountId
    if (settings.allowedModels !== undefined) changes.allowedModels = settings.allowedModels
    if (settings.deniedModels !== undefined) changes.deniedModels = settings.deniedModels
    if (baseUrl !== undefined) changes.baseUrl = baseUrl

    if (Object.keys(changes).length > 0) {
      const at = this.#clock.now()
      await this.#database.transaction(async (repositories) => {
        await repositories.providers.updateKey(keyId, changes, at)
        await repositories.audit.record({
          action: 'key.configured',
          outcome: 'success',
          // Field names only: model IDs are configuration, not secrets.
          detail: { providerId, keyId, fields: Object.keys(changes) },
          at,
        })
      })
    }

    return { ok: true, value: await this.#viewOf(providerId) }
  }

  /** Creates an Upstream Account that groups keys sharing Provider billing or capacity. */
  async createAccount(
    providerId: string,
    input: { displayName: unknown },
  ): Promise<ProviderResult<ProviderView>> {
    const connection = await this.#database.providers.getProvider(providerId)
    if (connection === null) return failed({ code: 'provider_not_found' })
    if (connection.archivedAt !== null) return failed({ code: 'provider_archived' })

    const problems = displayNameProblems(input.displayName)
    if (problems.length > 0) return failed({ code: 'validation_failed', problems })

    const at = this.#clock.now()
    const accountId = newId('ua')
    await this.#database.transaction(async (repositories) => {
      await repositories.providers.insertAccount({
        id: accountId,
        providerId,
        displayName: (input.displayName as string).trim(),
        createdAt: at,
        updatedAt: at,
      })
      await repositories.audit.record({
        action: 'account.created',
        outcome: 'success',
        detail: { providerId, accountId },
        at,
      })
    })

    return { ok: true, value: await this.#viewOf(providerId) }
  }

  /** Renames an account. The identity stays put so assigned keys keep their grouping. */
  async updateAccount(
    providerId: string,
    accountId: string,
    input: { displayName?: unknown },
  ): Promise<ProviderResult<ProviderView>> {
    const account = await this.#locateAccount(providerId, accountId)
    if (!account.ok) return account

    if (input.displayName !== undefined) {
      const problems = displayNameProblems(input.displayName)
      if (problems.length > 0) return failed({ code: 'validation_failed', problems })

      const at = this.#clock.now()
      await this.#database.transaction(async (repositories) => {
        await repositories.providers.updateAccount(
          accountId,
          { displayName: (input.displayName as string).trim() },
          at,
        )
        await repositories.audit.record({
          action: 'account.updated',
          outcome: 'success',
          detail: { providerId, accountId },
          at,
        })
      })
    }

    return { ok: true, value: await this.#viewOf(providerId) }
  }

  /**
   * Removes an account. Its keys become independent again rather than being
   * deleted, so nothing the Owner configured is lost except the grouping.
   */
  async deleteAccount(
    providerId: string,
    accountId: string,
  ): Promise<ProviderResult<ProviderView>> {
    const account = await this.#locateAccount(providerId, accountId)
    if (!account.ok) return account

    const at = this.#clock.now()
    await this.#database.transaction(async (repositories) => {
      await repositories.providers.deleteAccount(accountId)
      await repositories.audit.record({
        action: 'account.removed',
        outcome: 'success',
        detail: { providerId, accountId },
        at,
      })
    })

    return { ok: true, value: await this.#viewOf(providerId) }
  }

  /**
   * Resolves which Upstream Key serves one provider-scoped inference call.
   * Only an Active key whose per-key model rules admit the requested model is
   * eligible; the eligible keys of the connection rotate round-robin on a
   * volatile in-memory cursor. The winner's material is decrypted just long
   * enough for the request, the connection must be enabled and unarchived,
   * and an enabled connection with no eligible key is reported rather than
   * guessed at. Selection never writes to the database.
   */
  async resolveInference(
    providerId: string,
    model: string,
    excludedKeyIds: readonly string[] = [],
    ignoreUnknownScope = false,
  ): Promise<ProviderResult<InferenceTarget>> {
    const connection = await this.#database.providers.getProvider(providerId)
    if (connection === null) return failed({ code: 'provider_not_found' })
    if (connection.archivedAt !== null) return failed({ code: 'provider_archived' })
    if (!connection.enabled) return failed({ code: 'provider_disabled' })

    const excluded = new Set(excludedKeyIds)
    const keys = await this.#database.providers.listKeys(providerId)
    const at = this.#clock.now()
    const eligible = keys.filter((candidate) => {
      if (excluded.has(candidate.id) || !keyServesModel(candidate, model)) return false
      if (candidate.health === 'active') {
        return !scopeUnavailable(candidate, keys, model, at, ignoreUnknownScope)
      }
      if (candidate.health !== 'cooling_down' && candidate.health !== 'exhausted') return false
      if (candidate.retryAfterAt === null || candidate.retryAfterAt > at) return false
      return !this.#controlledTrials.has(healthClaim(candidate))
    })
    if (eligible.length === 0) return failed({ code: 'no_eligible_key' })

    const key = this.#selector.select(providerId, eligible)
    if (key === null) return failed({ code: 'no_eligible_key' })
    if (key.health !== 'active') {
      const claim = healthClaim(key)
      if (this.#controlledTrials.has(claim)) return failed({ code: 'no_eligible_key' })
      this.#controlledTrials.add(claim)
    }

    let upstreamKey: string
    try {
      upstreamKey = await this.#cipher.decrypt(key.encryptedKey)
    } catch (cause) {
      if (cause instanceof SecretCipherError) return failed({ code: 'stored_key_unreadable' })
      throw cause
    }

    const staticHeaders = await this.#decryptStaticHeaders(connection.staticHeadersEncrypted)
    const staticHeaderMap: Record<string, string> = {}
    for (const header of staticHeaders) staticHeaderMap[header.name] = header.value

    return {
      ok: true,
        value: {
          keyId: key.id,
          accountId: key.accountId,
          baseUrl: key.baseUrl ?? connection.baseUrl,
        allowInsecureHttp: connection.allowInsecureHttp,
        retryMaxAttempts: connection.retryMaxAttempts,
        retryAmbiguousNetwork: connection.retryAmbiguousNetwork,
        upstreamKey,
        authHeader: connection.authHeader,
        authPrefix: connection.authPrefix,
        staticHeaders: staticHeaderMap,
        redirectAllowSameOrigin: connection.redirectAllowSameOrigin,
        idempotencyHeader: connection.idempotencyHeader,
        connectionTimeoutMs: connection.connectionTimeoutMs,
        firstByteTimeoutMs: connection.firstByteTimeoutMs,
        nonStreamingTotalTimeoutMs: connection.nonStreamingTotalTimeoutMs,
        streamingIdleTimeoutMs: connection.streamingIdleTimeoutMs,
        totalRetryTimeoutMs: connection.totalRetryTimeoutMs,
      },
    }
  }

  async earliestRetryAfterSeconds(providerId: string): Promise<number | null> {
    const at = this.#clock.now()
    const seconds = (await this.#database.providers.listKeys(providerId))
      .flatMap((key) =>
        key.retryAfterAt === null
          ? []
          : [Math.ceil((key.retryAfterAt.getTime() - at.getTime()) / 1000)],
      )
      .filter((value) => value > 0)
      .sort((left, right) => left - right)[0]
    return seconds ?? null
  }

  async recordInferenceSuccess(keyId: string): Promise<void> {
    const key = await this.#database.providers.getKey(keyId)
    if (key === null) return
    this.#controlledTrials.delete(healthClaim(key))
    if (key.health === 'active') return
    const at = this.#clock.now()
    await this.#database.providers.updateKey(
      keyId,
      {
        health: 'active',
        healthReason: 'authoritative inference success',
        healthChangedAt: at,
        retryAfterAt: null,
        healthScope: 'key',
        healthScopeId: null,
        healthModel: null,
      },
      at,
    )
  }

  /**
   * Reactivates one or more keys from authoritative Usage Adapter evidence,
   * without paying for a real inference probe. Reactive-only evidence is
   * ignored: the rule is that only confirmed authority changes health.
   *
   * The scope the evidence names determines which keys reactivate:
   * `key` reactivates that single key; `account` reactivates every key in
   * the named account; `connection_model` reactivates the whole connection
   * for that one model (the scope the cooldown engine already uses);
   * `provider` reactivates the entire connection; `unknown` does not touch
   * any cooldown.
   */
  async reactivateFromUsage(
    providerId: string,
    evidence: UsageRecoveryEvidence,
  ): Promise<{ readonly reactivated: readonly string[] }> {
    if (!evidence.authoritative || !evidence.hasCapacity) {
      return { reactivated: [] }
    }

    const keys = await this.#database.providers.listKeys(providerId)
    const affected = eligibleForUsageRecovery(keys, evidence)

    const at = this.#clock.now()
    const reactivated: string[] = []
    for (const key of affected) {
      this.#controlledTrials.delete(healthClaim(key))
      await this.#database.providers.updateKey(
        key.id,
        {
          health: 'active',
          healthReason: 'authoritative usage adapter evidence',
          healthChangedAt: at,
          retryAfterAt: null,
          healthScope: 'key',
          healthScopeId: null,
          healthModel: null,
        },
        at,
      )
      reactivated.push(key.id)
    }

    if (reactivated.length > 0) {
      await this.#database.audit.record({
        action: 'key.reactivated_by_usage',
        outcome: 'success',
        detail: {
          providerId,
          reactivated: [...reactivated],
          scope: evidence.scope.kind,
        },
        at,
      })
    }

    return { reactivated }
  }

  /** Applies Provider-normalized evidence through the shared reconciliation engine. */
  async reconcileCapacityEvidence(input: {
    readonly providerId: string
    readonly keyId: string
    readonly model: string | null
    readonly capacityEvidence: readonly CapacityEvidence[]
    readonly credentialEvidence?: CredentialEvidence | null
  }): Promise<{ readonly reconciled: boolean; readonly routingEligible: boolean; readonly nextCheckAt: Date | null }> {
    const connection = await this.#database.providers.getProvider(input.providerId)
    const key = await this.#database.providers.getKey(input.keyId)
    if (connection === null || key === null || key.providerId !== input.providerId) {
      return { reconciled: false, routingEligible: false, nextCheckAt: null }
    }
    const at = this.#clock.now()
    const decision = reconcileCapacity({
      ownerEnabled: connection.enabled && key.health !== 'disabled',
      keyId: key.id,
      accountId: key.accountId,
      model: input.model,
      existing: {
        health: key.health,
        reason: key.healthReason,
        retryAfterAt: key.retryAfterAt,
        scope: key.healthScope,
        scopeId: key.healthScopeId,
        model: key.healthModel,
      },
      credentialEvidence: input.credentialEvidence ?? null,
      capacityEvidence: input.capacityEvidence,
      now: at,
    })
    await this.#database.providers.updateKey(key.id, {
      health: decision.health,
      healthReason: decision.reason,
      healthChangedAt: decision.health === key.health ? key.healthChangedAt : at,
      retryAfterAt: decision.nextCheckAt,
      healthScope: decision.scope,
      healthScopeId: decision.scopeId,
      healthModel: decision.model,
    }, at)
    return { reconciled: true, routingEligible: decision.routingEligible, nextCheckAt: decision.nextCheckAt }
  }

  async recordInferenceFailure(input: {
    keyId: string
    model: string
    classification?: InferenceFailureClassification
    /** Legacy direct-call input; Gateway inference supplies `classification`. */
    status?: number
    retryAfterSeconds?: number | null
    reason: string
  }): Promise<void> {
    const key = await this.#database.providers.getKey(input.keyId)
    if (key === null) return
    this.#controlledTrials.delete(healthClaim(key))
    const at = this.#clock.now()
    const classification = input.classification ?? legacyFailureClassification(
      input.status,
      input.retryAfterSeconds ?? null,
      key.accountId !== null,
    )
    if (classification === null) return
    const retryAfterAt = new Date(at.getTime() + Math.max(1, classification.retryAfterSeconds ?? 30) * 1000)
    if (classification.kind === 'authentication_invalid') {
      await this.#database.providers.updateKey(
        key.id,
        healthPatch('invalid_authentication', input.reason, at, null, 'key', key.id, null),
        at,
      )
      return
    }
    if (classification.kind === 'authentication_rejected') {
      await this.#database.providers.updateKey(
        key.id,
        healthPatch('cooling_down', input.reason, at, retryAfterAt, 'key', key.id, null),
        at,
      )
      return
    }
    if (classification.kind === 'capacity_limited') {
      if (input.classification !== undefined && (classification.capacityEvidence === undefined
        || classification.capacityEvidence.authority !== 'authoritative')) return
      const scope = classification.capacityScope === 'account' && key.accountId !== null ? 'account' : 'unknown'
      const scopeId = key.accountId
      const affected =
        scope === 'account'
          ? (await this.#database.providers.listKeys(key.providerId)).filter(
              (candidate) => candidate.accountId === key.accountId,
            )
          : [key]
      await Promise.all(
        affected.map((candidate) =>
          this.#database.providers.updateKey(
            candidate.id,
            healthPatch('exhausted', input.reason, at, retryAfterAt, scope, scopeId, null),
            at,
          ),
        ),
      )
      return
    }
    if (classification.kind === 'provider_failure') {
      await this.#database.providers.updateKey(
        key.id,
        healthPatch(
          'cooling_down',
          input.reason,
          at,
          retryAfterAt,
          'connection_model',
          key.providerId,
          input.model,
        ),
        at,
      )
    }
  }

  async #locateKey(
    providerId: string,
    keyId: string,
  ): Promise<
    ProviderResult<{ readonly connection: ProviderRecord; readonly key: UpstreamKeyRecord }>
  > {
    const connection = await this.#database.providers.getProvider(providerId)
    if (connection === null) return failed({ code: 'provider_not_found' })
    if (connection.archivedAt !== null) return failed({ code: 'provider_archived' })

    const key = await this.#database.providers.getKey(keyId)
    if (key === null || key.providerId !== providerId) return failed({ code: 'key_not_found' })

    return { ok: true, value: { connection, key } }
  }

  /**
   * Tests every Unverified Upstream Key of one Provider the way creation and
   * duplication do, at most {@link PROBE_CONCURRENCY} at a time.
   *
   * Order is deliberately undefined: each key carries its own base URL and its
   * own row, and its verdict is computed from the state read before the pass
   * began, so nothing one probe learns can change what another records.
   */
  async #probeConnectionKeys(providerId: string): Promise<void> {
    const connection = await this.#database.providers.getProvider(providerId)
    if (connection === null) return

    // One snapshot the workers share: the pass probes the keys that were
    // Unverified when it began, not whatever the pool sees as verdicts land.
    const unverified = (await this.#database.providers.listKeys(providerId)).filter(
      (key) => key.health === 'unverified',
    )

    await forEachWithConcurrency(unverified, PROBE_CONCURRENCY, async (key) => {
      // The probe must hit the URL the key will actually use at inference
      // time, not always the Provider's default — a key with its own
      // override URL is meaningless if its health verdict was earned against
      // a different endpoint. Resolved per key inside the pool, so two probes
      // in flight cannot borrow each other's endpoint.
      const probeBaseUrl = key.baseUrl ?? connection.baseUrl
      const probe = await this.#runProbe(probeBaseUrl, key.encryptedKey)
      if (!probe.readable) return

      const at = this.#clock.now()
      await this.#database.providers.updateKey(
        key.id,
        probedPatch(key, probe, at),
        at,
      )
    })
  }

  async #runProbe(
    baseUrl: string,
    encryptedKey: string,
  ): Promise<ProbeRun> {
    let plaintext: string
    try {
      plaintext = await this.#cipher.decrypt(encryptedKey)
    } catch (cause) {
      if (cause instanceof SecretCipherError) return { readable: false }
      throw cause
    }

    try {
      const { verdict, reason } = await this.#probe.test({ baseUrl, upstreamKey: plaintext })
      return { readable: true, verdict, reason }
    } catch {
      return { readable: true, verdict: 'inconclusive', reason: 'the key test did not complete' }
    }
  }

  async #keysOf(providerId: string): Promise<readonly KeyView[]> {
    const keys = await this.#database.providers.listKeys(providerId)
    // Keys cannot exist without their Provider (FK), so the lookup is
    // structural: a missing Provider here is a data-integrity violation,
    // not a normal condition the view needs to render gracefully.
    const provider = await this.#database.providers.getProvider(providerId)
    if (provider === null) {
      throw new Error(`Provider ${providerId} vanished mid-render`)
    }
    const providerDefault = provider.baseUrl

    return keys.map((key) => ({
      id: key.id,
      health: key.health,
      baseUrl: key.baseUrl,
      effectiveBaseUrl: key.baseUrl ?? providerDefault,
      lastProbe:
        key.lastProbeAt === null || key.lastProbeVerdict === null
          ? null
          : { at: key.lastProbeAt, verdict: key.lastProbeVerdict, reason: key.lastProbeReason },
      healthReason: key.healthReason,
      healthChangedAt: key.healthChangedAt,
      retryAfterAt: key.retryAfterAt,
      healthScope: key.healthScope,
      healthScopeId: key.healthScopeId,
      healthModel: key.healthModel,
      accountId: key.accountId,
      allowedModels: key.allowedModels,
      deniedModels: key.deniedModels,
      createdAt: key.createdAt,
      updatedAt: key.updatedAt,
    }))
  }

  async #accountsOf(providerId: string): Promise<readonly UpstreamAccountView[]> {
    const accounts = await this.#database.providers.listAccounts(providerId)

    return accounts.map((account) => ({
      id: account.id,
      displayName: account.displayName,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    }))
  }

  async #locateAccount(
    providerId: string,
    accountId: string,
  ): Promise<ProviderResult<UpstreamAccountRecord>> {
    const connection = await this.#database.providers.getProvider(providerId)
    if (connection === null) return failed({ code: 'provider_not_found' })
    if (connection.archivedAt !== null) return failed({ code: 'provider_archived' })

    const account = await this.#database.providers.getAccount(accountId)
    if (account === null || account.providerId !== providerId) {
      return failed({ code: 'account_not_found' })
    }

    return { ok: true, value: account }
  }

  async #viewOf(id: string): Promise<ProviderView> {
    const connection = await this.#database.providers.getProvider(id)
    if (connection === null) throw new Error(`Provider connection ${id} vanished mid-operation`)

    let staticHeaders: readonly ProviderStaticHeader[] = []
    try {
      staticHeaders = await this.#decryptStaticHeaders(connection.staticHeadersEncrypted)
    } catch (cause) {
      if (cause instanceof SecretCipherError) {
        throw new Error('stored static headers are unreadable; the installation master key may have changed')
      }
      throw cause
    }

    return {
      ...summaryOf(connection),
      staticHeaders: staticHeaders.map((header) => ({ name: header.name })),
      warnings: connection.allowInsecureHttp ? ['insecure_http'] : [],
      keys: await this.#keysOf(connection.id),
      accounts: await this.#accountsOf(connection.id),
    }
  }

  /**
   * Encrypts the connection's static headers as a JSON-encoded array of
   * {name, value} pairs. The cipher output for each value travels together
   * inside one outer ciphertext so a database copy does not yield any value
   * plaintext without the master key.
   */
  async #encryptStaticHeaders(headers: readonly ProviderStaticHeader[]): Promise<string> {
    if (headers.length === 0) return STATIC_HEADERS_BLANK
    const plainJson = JSON.stringify(headers.map((header) => ({ name: header.name, value: header.value })))
    return await this.#cipher.encrypt(plainJson)
  }

  /**
   * Decrypts the stored static headers back to a list of {name, value}
   * pairs. A stored value of `[]` (the column default) returns an empty
   * list without a cipher call, so an empty default never errors.
   */
  async #decryptStaticHeaders(stored: string): Promise<readonly ProviderStaticHeader[]> {
    if (stored === STATIC_HEADERS_BLANK) return []
    const plainJson = await this.#cipher.decrypt(stored)
    const parsed = JSON.parse(plainJson) as unknown
    if (!Array.isArray(parsed)) return []
    const headers: ProviderStaticHeader[] = []
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue
      const name = (entry as Record<string, unknown>).name
      const value = (entry as Record<string, unknown>).value
      if (typeof name !== 'string' || typeof value !== 'string') continue
      headers.push({ name, value })
    }
    return headers
  }
}

/**
 * Visits every value, keeping at most `limit` visits in flight.
 *
 * Workers share one cursor rather than taking a fixed slice each, so one slow
 * upstream never leaves the rest of the pool idle. A visit that throws is held
 * back rather than allowed to abandon the queue: every remaining value still
 * gets its turn, and only then is the first failure re-raised. That matters for
 * a probe pass, whose whole purpose is to record the verdicts it did earn —
 * rejecting early would return to the caller while sibling probes were still
 * running, and their writes would land after the answer had been sent.
 */
async function forEachWithConcurrency<T>(
  values: readonly T[],
  limit: number,
  visit: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const failures: unknown[] = []

  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const value = values[next++]!
      try {
        await visit(value)
      } catch (cause) {
        failures.push(cause)
      }
    }
  })
  await Promise.all(workers)

  if (failures.length > 0) throw failures[0]
}

/** One attempt to probe a stored key. Either it ran or the material was unreadable. */
type ProbeRun =
  | { readonly readable: false }
  | { readonly readable: true; readonly verdict: KeyProbeVerdict; readonly reason: string | null }

/** The stored result of one probe; optionally activating an unverified key. */
/**
 * Computes the post-test patch from the probe verdict and the key's current
 * state. A disabled key never moves on a test result; only the Owner's
 * explicit Activate revives it. Every other key takes the verdict as the
 * source of truth for its new health.
 */
function probedPatch(
  key: { readonly id: string; readonly health: UpstreamKeyHealth },
  probe: { readonly verdict: KeyProbeVerdict; readonly reason: string | null },
  at: Date,
): UpstreamKeyPatch {
  if (key.health === 'disabled') {
    return {
      lastProbeAt: at,
      lastProbeVerdict: probe.verdict,
      lastProbeReason: probe.reason,
    }
  }
  switch (probe.verdict) {
    case 'authenticated':
      if (key.health === 'exhausted' || key.health === 'invalid_authentication') {
        return {
          lastProbeAt: at,
          lastProbeVerdict: probe.verdict,
          lastProbeReason: probe.reason,
        }
      }
      return {
        health: 'active',
        healthReason: 'manual test confirmed authentication',
        healthChangedAt: at,
        retryAfterAt: null,
        healthScope: 'key',
        healthScopeId: null,
        healthModel: null,
        lastProbeAt: at,
        lastProbeVerdict: probe.verdict,
        lastProbeReason: probe.reason,
      }
    case 'rejected':
      return {
        health: 'invalid_authentication',
        healthReason: probe.reason ?? 'upstream rejected the test request',
        healthChangedAt: at,
        retryAfterAt: null,
        healthScope: 'key',
        healthScopeId: key.id,
        healthModel: null,
        lastProbeAt: at,
        lastProbeVerdict: probe.verdict,
        lastProbeReason: probe.reason,
      }
    case 'inconclusive':
      return {
        health: 'cooling_down',
        healthReason: probe.reason ?? 'test could not reach the upstream',
        healthChangedAt: at,
        retryAfterAt: new Date(at.getTime() + 30 * 1000),
        healthScope: 'key',
        healthScopeId: key.id,
        healthModel: null,
        lastProbeAt: at,
        lastProbeVerdict: probe.verdict,
        lastProbeReason: probe.reason,
      }
  }
}

function summaryOf(provider: {
  id: string
  handle: string
  displayName: string
  baseUrl: string
  allowInsecureHttp: boolean
  enabled: boolean
  retryMaxAttempts: number
  retryAmbiguousNetwork: boolean
  archivedAt: Date | null
  templateId: string | null
  logoDomain: string | null
  authHeader: string
  authPrefix: string
  staticHeadersEncrypted: string
  redirectAllowSameOrigin: boolean
  connectionTimeoutMs: number
  firstByteTimeoutMs: number
  nonStreamingTotalTimeoutMs: number
  streamingIdleTimeoutMs: number
  totalRetryTimeoutMs: number
  idempotencyHeader: string
  createdAt: Date
  updatedAt: Date
}): Omit<ProviderView, 'keys' | 'accounts' | 'staticHeaders' | 'warnings'> {
  return {
    id: provider.id,
    handle: provider.handle,
    displayName: provider.displayName,
    baseUrl: provider.baseUrl,
    logoDomain: provider.logoDomain,
    allowInsecureHttp: provider.allowInsecureHttp,
    enabled: provider.enabled,
    retryMaxAttempts: provider.retryMaxAttempts,
    retryAmbiguousNetwork: provider.retryAmbiguousNetwork,
    archived: provider.archivedAt !== null,
    templateId: provider.templateId,
    authHeader: provider.authHeader,
    authPrefix: provider.authPrefix,
    redirectAllowSameOrigin: provider.redirectAllowSameOrigin,
    connectionTimeoutMs: provider.connectionTimeoutMs,
    firstByteTimeoutMs: provider.firstByteTimeoutMs,
    nonStreamingTotalTimeoutMs: provider.nonStreamingTotalTimeoutMs,
    streamingIdleTimeoutMs: provider.streamingIdleTimeoutMs,
    totalRetryTimeoutMs: provider.totalRetryTimeoutMs,
    idempotencyHeader: provider.idempotencyHeader,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  }
}

function logoDomainFromBaseUrl(baseUrl: string): string | null {
  try {
    return normalizeLogoDomainInput(new URL(baseUrl).hostname)
  } catch {
    return null
  }
}

function readLogoDomainInput(input: unknown):
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly problem: FieldProblem } {
  if (input === null || (typeof input === 'string' && input.trim() === '')) {
    return { ok: true, value: null }
  }
  if (typeof input !== 'string') {
    return {
      ok: false,
      problem: { field: 'logoDomain', message: 'must be a valid hostname, HTTP(S) URL, or null' },
    }
  }
  const normalized = normalizeLogoDomainInput(input)
  return normalized === null
    ? { ok: false, problem: { field: 'logoDomain', message: 'must be a valid hostname or HTTP(S) URL' } }
    : { ok: true, value: normalized }
}

function displayNameProblems(input: unknown): readonly FieldProblem[] {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return [{ field: 'displayName', message: 'is required' }]
  }

  if (input.trim().length > DISPLAY_NAME_MAXIMUM) {
    return [{ field: 'displayName', message: `must be at most ${DISPLAY_NAME_MAXIMUM} characters` }]
  }

  return []
}

function providerHandleProblems(input: unknown): readonly FieldProblem[] {
  if (typeof input !== 'string' || input.length === 0) return [{ field: 'handle', message: 'is required' }]
  if (input.length > 63) return [{ field: 'handle', message: 'must be at most 63 characters' }]
  return PROVIDER_HANDLE_PATTERN.test(input)
    ? []
    : [{ field: 'handle', message: 'must contain lowercase letters, numbers, and single hyphens only' }]
}

export function isProviderHandle(input: string): boolean {
  return input.length >= 1 && input.length <= 63 && PROVIDER_HANDLE_PATTERN.test(input)
}

function isUniqueConstraintFailure(cause: unknown): boolean {
  const error = cause as { message?: string; code?: string }
  return /providers_handle_unique|providers\.handle/i.test(`${error?.message ?? cause} ${error?.code ?? ''}`)
}

function baseUrlProblems(input: unknown, allowInsecureHttp: boolean): readonly FieldProblem[] {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return [{ field: 'baseUrl', message: 'is required' }]
  }

  const raw = input.trim()
  if (raw.length > BASE_URL_MAXIMUM) {
    return [{ field: 'baseUrl', message: `must be at most ${BASE_URL_MAXIMUM} characters` }]
  }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return [{ field: 'baseUrl', message: 'is not a parseable URL' }]
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return [{ field: 'baseUrl', message: 'must use https:// or, explicitly, http://' }]
  }

  if (url.protocol === 'http:' && !allowInsecureHttp) {
    return [
      {
        field: 'baseUrl',
        message: 'uses plain HTTP, which sends the Upstream Key unencrypted; allow it explicitly',
      },
    ]
  }

  if (url.username !== '' || url.password !== '') {
    return [{ field: 'baseUrl', message: 'must not embed a username or password' }]
  }

  return []
}

function upstreamKeyProblems(input: unknown): readonly FieldProblem[] {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return [{ field: 'upstreamKey', message: 'is required' }]
  }

  if (input.trim().length > UPSTREAM_KEY_MAXIMUM) {
    return [{ field: 'upstreamKey', message: `must be at most ${UPSTREAM_KEY_MAXIMUM} characters` }]
  }

  return []
}

/**
 * An authentication header name must either be one of the adapter-approved
 * names (Authorization, X-Api-Key, Api-Key) or a printable ASCII custom name
 * matching `[A-Za-z0-9-]{1,128}`. The regex forbids whitespace, colons,
 * semicolons, and any byte that could be used to inject header folds.
 */
function authHeaderProblems(input: unknown): readonly FieldProblem[] {
  if (typeof input !== 'string' || input.length === 0) {
    return [{ field: 'authHeader', message: 'is required' }]
  }

  if (input.length > AUTH_HEADER_MAXIMUM) {
    return [{ field: 'authHeader', message: `must be at most ${AUTH_HEADER_MAXIMUM} characters` }]
  }

  if (APPROVED_AUTH_HEADERS.has(input.toLowerCase())) return []
  if (/^[A-Za-z0-9-]{1,128}$/.test(input)) return []
  return [
    {
      field: 'authHeader',
      message: 'must be a printable header name; only Authorization, X-Api-Key, Api-Key, or a [A-Za-z0-9-]{1,128} custom name are accepted',
    },
  ]
}

/**
 * An authentication prefix must be printable ASCII with no control characters
 * or newlines, and within a generous length bound. An empty prefix is allowed
 * and means "no prefix"; only the key follows the header name.
 */
function authPrefixProblems(input: unknown): readonly FieldProblem[] {
  if (typeof input !== 'string') {
    return [{ field: 'authPrefix', message: 'must be a string' }]
  }

  if (input.length > AUTH_PREFIX_MAXIMUM) {
    return [{ field: 'authPrefix', message: `must be at most ${AUTH_PREFIX_MAXIMUM} characters` }]
  }

  // Printable ASCII without CR/LF/NUL or other control characters.
  if (/^[\x20-\x7E]*$/.test(input)) return []
  return [{ field: 'authPrefix', message: 'must be printable ASCII without control characters' }]
}

/**
 * Idempotency headers reuse the same validation shape as auth headers: they
 * must be a printable HTTP token. The default `Idempotency-Key` is what the
 * OpenAI-compatible family uses.
 */
function idempotencyHeaderProblems(input: unknown): readonly FieldProblem[] {
  if (typeof input !== 'string' || input.length === 0) {
    return [{ field: 'idempotencyHeader', message: 'is required' }]
  }
  if (input.length > AUTH_HEADER_MAXIMUM) {
    return [{ field: 'idempotencyHeader', message: `must be at most ${AUTH_HEADER_MAXIMUM} characters` }]
  }
  if (/^[A-Za-z0-9-]{1,128}$/.test(input)) return []
  return [{ field: 'idempotencyHeader', message: 'must be a printable header name' }]
}

/**
 * Timeouts are positive integers within a generous bound. The lower bound
 * keeps a malformed zero from being silently accepted; the upper bound stops
 * a typo from making the connection effectively hang forever.
 */
function timeoutProblems(field: string, input: unknown): readonly FieldProblem[] {
  if (input === undefined) return []
  if (typeof input !== 'number' || !Number.isInteger(input)) {
    return [{ field, message: 'must be an integer number of milliseconds' }]
  }
  if (input < TIMEOUT_MINIMUM_MS || input > TIMEOUT_MAXIMUM_MS) {
    return [
      {
        field,
        message: `must be between ${TIMEOUT_MINIMUM_MS} and ${TIMEOUT_MAXIMUM_MS} milliseconds`,
      },
    ]
  }
  return []
}

/** A default fallback used by the update path so a supplied value never silently vanishes. */
function numericDefault(input: unknown, fallback: number): number {
  if (typeof input !== 'number' || !Number.isInteger(input)) return fallback
  return input
}

/**
 * Reads and validates a list of static headers. Names share the auth-header
 * shape so they cannot smuggle header folds or colons; values are plain
 * strings within a generous bound. The whole list is encrypted together when
 * it is persisted.
 */
function readStaticHeaders(input: unknown, problems: FieldProblem[]): readonly ProviderStaticHeader[] {
  if (input === undefined) return []
  if (!Array.isArray(input)) {
    problems.push({ field: 'staticHeaders', message: 'must be a list of {name, value} entries' })
    return []
  }

  if (input.length > STATIC_HEADER_MAXIMUM_ENTRIES) {
    problems.push({
      field: 'staticHeaders',
      message: `holds at most ${STATIC_HEADER_MAXIMUM_ENTRIES} entries`,
    })
  }

  const headers: ProviderStaticHeader[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    if (typeof raw !== 'object' || raw === null) {
      problems.push({ field: 'staticHeaders', message: 'each entry must be a {name, value} object' })
      continue
    }
    const entry = raw as Record<string, unknown>
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    const value = typeof entry.value === 'string' ? entry.value : null
    if (name === '') {
      problems.push({ field: 'staticHeaders.name', message: 'is required' })
      continue
    }
    if (name.length > AUTH_HEADER_MAXIMUM || !/^[A-Za-z0-9-]{1,128}$/.test(name)) {
      problems.push({ field: `staticHeaders.name`, message: 'must be a printable header name' })
      continue
    }
    if (value === null) {
      problems.push({ field: `staticHeaders.${name}.value`, message: 'must be a string' })
      continue
    }
    if (value.length > STATIC_HEADER_VALUE_MAXIMUM) {
      problems.push({
        field: `staticHeaders.${name}.value`,
        message: `must be at most ${STATIC_HEADER_VALUE_MAXIMUM} characters`,
      })
      continue
    }
    const lower = name.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    headers.push({ name, value })
  }

  return headers
}

const MODEL_ID_MAXIMUM = 128
const MODEL_LIST_MAXIMUM = 500

/**
 * Whether a key may serve one requested model. The account never adds a
 * blocker here: any key with no per-key objection is eligible, whether it is
 * grouped or independent. An unverified or disabled key is never eligible.
 */
function keyServesModel(key: UpstreamKeyRecord, model: string): boolean {
  if (key.allowedModels !== null && !key.allowedModels.includes(model)) return false
  if (key.deniedModels !== null && key.deniedModels.includes(model)) return false
  return true
}

function healthClaim(key: UpstreamKeyRecord): string {
  return `${key.healthScope}:${key.healthScopeId ?? key.id}:${key.healthModel ?? ''}`
}

function scopeUnavailable(
  key: UpstreamKeyRecord,
  keys: readonly UpstreamKeyRecord[],
  model: string,
  at: Date,
  ignoreUnknownScope: boolean,
): boolean {
  return keys.some((candidate) => {
    if (
      candidate.health !== 'cooling_down' &&
      candidate.health !== 'exhausted' &&
      candidate.health !== 'invalid_authentication'
    ) {
      return false
    }
    if (candidate.retryAfterAt !== null && candidate.retryAfterAt <= at) return false
    switch (candidate.healthScope) {
      case 'key':
        return candidate.id === key.id
      case 'account':
        return candidate.healthScopeId !== null && candidate.healthScopeId === key.accountId
      case 'connection_model':
        return candidate.providerId === key.providerId && candidate.healthModel === model
      case 'provider':
        return candidate.providerId === key.providerId
      case 'unknown':
        return !ignoreUnknownScope && candidate.providerId === key.providerId
    }
  })
}

function healthPatch(
  health: UpstreamKeyHealth,
  reason: string,
  at: Date,
  retryAfterAt: Date | null,
  scope: UpstreamKeyRecord['healthScope'],
  scopeId: string | null,
  model: string | null,
): UpstreamKeyPatch {
  return {
    health,
    healthReason: reason,
    healthChangedAt: at,
    retryAfterAt,
    healthScope: scope,
    healthScopeId: scopeId,
    healthModel: model,
  }
}

/**
 * Reads one per-key model list. `undefined` means the field was not supplied;
 * `null` means "no restriction". Every entry must be a non-empty exact model
 * ID, is trimmed, deduplicated, and kept in the order it was submitted.
 */
function readModelList(
  input: unknown,
  field: string,
  problems: FieldProblem[],
): readonly string[] | null | undefined {
  if (input === undefined) return undefined
  if (input === null) return null

  if (!Array.isArray(input)) {
    problems.push({ field, message: 'must be a list of exact model IDs or null' })
    return undefined
  }

  const models: string[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    if (typeof raw !== 'string') {
      problems.push({ field, message: 'each model ID must be text' })
      continue
    }

    const model = raw.trim()
    if (model === '') continue
    if (model.length > MODEL_ID_MAXIMUM) {
      problems.push({ field, message: `model IDs are at most ${MODEL_ID_MAXIMUM} characters` })
      continue
    }
    if (seen.has(model)) continue
    seen.add(model)
    models.push(model)
  }

  if (models.length > MODEL_LIST_MAXIMUM) {
    problems.push({ field, message: `holds at most ${MODEL_LIST_MAXIMUM} model IDs` })
  }

  return models
}

/**
 * Reads and validates the `keys` array passed to `create`. Each entry must
 * carry a non-empty `upstreamKey`; each may carry an optional `baseUrl`
 * override that follows the same per-Key inheritance rules as `addKey`.
 *
 * Empty arrays are rejected so a Provider always lands with at least one
 * usable Upstream Key. Non-array input, missing fields, or any per-key
 * validation failure is reported as a field problem tagged `keys` (or the
 * specific sub-field) so the Owner-facing form can highlight the right row.
 */
function readCreateKeys(
  input: unknown,
  providerBaseUrl: string,
  problems: FieldProblem[],
): readonly { readonly upstreamKey: string; readonly baseUrl: string | null }[] {
  if (!Array.isArray(input)) {
    problems.push({ field: 'keys', message: 'must be a non-empty list of Upstream Keys' })
    return []
  }

  if (input.length === 0) {
    problems.push({ field: 'keys', message: 'must contain at least one Upstream Key' })
    return []
  }

  // Per-key base URL overrides inherit the Provider's http allowance: a
  // Provider on plain HTTP lets its keys point at any plain-HTTP endpoint.
  // Mirrors the rule `addKey` enforces so the two flows feel identical.
  const allowInsecureHttp = (() => {
    try {
      return new URL(providerBaseUrl).protocol === 'http:'
    } catch {
      return false
    }
  })()

  const out: { upstreamKey: string; baseUrl: string | null }[] = []

  input.forEach((entry, index) => {
    if (entry === null || typeof entry !== 'object') {
      problems.push({ field: `keys[${index}]`, message: 'must be an Upstream Key object' })
      return
    }

    const candidate = entry as { upstreamKey?: unknown; baseUrl?: unknown }
    const keyProblems = upstreamKeyProblems(candidate.upstreamKey)
    for (const problem of keyProblems) {
      problems.push({ field: `keys[${index}].${problem.field}`, message: problem.message })
    }
    if (keyProblems.length > 0) return

    // Per-Key base URL override is optional; the same inheritance rules as
    // `addKey` apply (blank string -> inherit Provider default -> null).
    const baseUrl = readCreateKeyBaseUrl(candidate.baseUrl, providerBaseUrl, allowInsecureHttp, index, problems)
    if (baseUrl === undefined) return

    out.push({ upstreamKey: (candidate.upstreamKey as string).trim(), baseUrl })
  })

  return out
}

/**
 * Per-Key base URL override for the `create` flow. Returns `null` when the
 * key inherits the Provider default, the trimmed URL string when one is set,
 * or `undefined` when validation failed and a problem was already reported.
 *
 * Split from `readKeyBaseUrl` so the field name can be tagged with the
 * offending row index (`keys[i].baseUrl`) rather than the bare `baseUrl`
 * that single-key paths use.
 */
function readCreateKeyBaseUrl(
  input: unknown,
  providerBaseUrl: string,
  allowInsecureHttp: boolean,
  index: number,
  problems: FieldProblem[],
): string | null | undefined {
  if (input === undefined || input === null) return null
  if (typeof input !== 'string') {
    problems.push({ field: `keys[${index}].baseUrl`, message: 'must be a base URL string or null' })
    return undefined
  }
  const trimmed = input.trim()
  if (trimmed === '') return null
  const fieldProblems = baseUrlProblems(trimmed, allowInsecureHttp)
  for (const problem of fieldProblems) {
    problems.push({ field: `keys[${index}].baseUrl`, message: problem.message })
  }
  return fieldProblems.length === 0 ? trimmed : undefined
}

/**
 * Reads and validates a per-Key base URL override. The inheritance rules live
 * here rather than in the HTTP layer so the same validation applies whether
 * the Key is being added through the Owner dialog or through a future Owner API
 * call: a blank string means "no override", an unset value means "use the
 * Provider's default" (`null`), and a non-empty value is validated like a
 * regular base URL.
 */
function readKeyBaseUrl(
  input: unknown,
  providerBaseUrl: string,
  problems: FieldProblem[],
): string | null {
  if (input === undefined || input === null) return null
  if (typeof input !== 'string') {
    problems.push({ field: 'baseUrl', message: 'must be a base URL string or null' })
    return null
  }
  const trimmed = input.trim()
  if (trimmed === '') return null
  // Reuse the connection-level validation so the Owner UI applies the same
  // http-vs-https rules to per-Key URLs as to the Provider URL itself.
  const allowInsecureHttp = (() => {
    try {
      return new URL(providerBaseUrl).protocol === 'http:'
    } catch {
      return false
    }
  })()
  const fieldProblems = baseUrlProblems(trimmed, allowInsecureHttp)
  for (const problem of fieldProblems) {
    problems.push({ field: 'baseUrl', message: problem.message })
  }
  return trimmed
}

/**
 * Reads the Owner-editable settings for an Upstream Key — which account it
 * shares billing or capacity with, and which exact model IDs it may or may
 * not serve. Each field is optional on the input: `undefined` means "leave
 * it alone" (PATCH) or "use the default" (POST). `null` clears the field.
 *
 * Used by both `addKey` (POST) and `updateKeySettings` (PATCH) so the two
 * flows surface identical validation.
 */
async function readKeySettings(
  providers: ProviderRepository,
  providerId: string,
  input: { accountId?: unknown; allowedModels?: unknown; deniedModels?: unknown },
  problems: FieldProblem[],
): Promise<{
  accountId?: string | null
  allowedModels?: readonly string[] | null
  deniedModels?: readonly string[] | null
}> {
  const result: {
    accountId?: string | null
    allowedModels?: readonly string[] | null
    deniedModels?: readonly string[] | null
  } = {}

  if (input.accountId !== undefined) {
    if (input.accountId === null) {
      result.accountId = null
    } else if (typeof input.accountId === 'string' && input.accountId.trim() !== '') {
      const account = await providers.getAccount(input.accountId.trim())
      if (account === null || account.providerId !== providerId) {
        problems.push({
          field: 'accountId',
          message: 'names an Upstream Account this connection does not own',
        })
      } else {
        result.accountId = account.id
      }
    } else {
      problems.push({ field: 'accountId', message: 'must be an Upstream Account id or null' })
    }
  }

  if (input.allowedModels !== undefined) {
    const parsed = readModelList(input.allowedModels, 'allowedModels', problems)
    if (parsed !== undefined) result.allowedModels = parsed
  }

  if (input.deniedModels !== undefined) {
    const parsed = readModelList(input.deniedModels, 'deniedModels', problems)
    if (parsed !== undefined) result.deniedModels = parsed
  }

  return result
}

/** A duplicate gets a recognisably related name without colliding silently. */
function copiedName(displayName: string): string {
  const suffix = ' (copy)'
  const stem = displayName.slice(0, DISPLAY_NAME_MAXIMUM - suffix.length)
  return `${stem}${suffix}`
}

export function suggestAvailableProviderHandle(source: string, used: ReadonlySet<string>): string {
  for (let number = 2; ; number++) {
    const suffix = `-${number}`
    const candidate = `${source.slice(0, 63 - suffix.length).replace(/-+$/, '')}${suffix}`
    if (!used.has(candidate)) return candidate
  }
}

/**
 * The keys whose cooldown the evidence can resolve. Disabled and Active keys
 * are never touched; the evidence must name a scope the existing cooldown
 * engine would have used, otherwise the recovery would be too aggressive.
 */
function eligibleForUsageRecovery(
  keys: readonly UpstreamKeyRecord[],
  evidence: UsageRecoveryEvidence,
): readonly UpstreamKeyRecord[] {
  const cooling = keys.filter(
    (key) => key.health === 'cooling_down' || key.health === 'exhausted',
  )
  const scope = evidence.scope

  switch (scope.kind) {
    case 'key':
      return cooling.filter((key) => key.id === scope.keyId)
    case 'account':
      return cooling.filter((key) => key.accountId === scope.accountId)
    case 'connection_model':
      return cooling.filter((key) => key.healthModel === scope.model)
    case 'provider':
      return cooling
    case 'unknown':
      return []
  }
}

/**
 * The honest default capability claim for a connection created without a
 * Provider Template in the registry: unknown-off, never assumed. Template and
 * catalog work can enrich these claims later without Iroha silently assuming a
 * Provider behaves like a different one.
 */
function defaultCapabilities(): ProviderCapabilities {
  return {
    chat: false,
    streaming: false,
    tools: false,
    structuredOutput: false,
    responses: false,
  }
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('base64url')}`
}

function failed(failure: ProviderFailure): ProviderResult<never> {
  return { ok: false, failure }
}

function legacyFailureClassification(
  status: number | undefined,
  retryAfterSeconds: number | null,
  hasAccount: boolean,
): InferenceFailureClassification | null {
  if (status === 401) return { kind: 'authentication_invalid', capacityScope: 'key', retryAction: 'try_alternate', retryAfterSeconds }
  if (status === 403) return { kind: 'authentication_rejected', capacityScope: 'key', retryAction: 'try_alternate', retryAfterSeconds }
  if (status === 429) return { kind: 'capacity_limited', capacityScope: hasAccount ? 'account' : 'unknown', retryAction: 'try_alternate', retryAfterSeconds }
  if (status !== undefined && status >= 500) return { kind: 'provider_failure', capacityScope: 'connection_model', retryAction: 'retry_same', retryAfterSeconds }
  return null
}
