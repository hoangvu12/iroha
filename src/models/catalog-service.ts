import { SecretCipherError, type SecretCipher } from '../crypto/index.ts'
import type { InferenceAdapter } from '../inference/index.ts'
import type {
  ProviderCapabilities,
  Database,
  ModelCatalogSource,
  ModelCatalogSyncRecord,
  ProviderRecord,
} from '../persistence/index.ts'
import type { AdapterRegistry } from '../providers/adapter-registry.ts'
import { systemClock, type Clock } from '../runtime/clock.ts'

export interface FieldProblem {
  readonly field: string
  readonly message: string
}

export type ModelCatalogFailure =
  | { readonly code: 'provider_not_found' }
  | { readonly code: 'provider_archived' }
  | { readonly code: 'provider_disabled' }
  /** No Upstream Key on the connection is usable for a read-only discovery. */
  | { readonly code: 'no_eligible_key' }
  /** Encrypted material could not be read; the master key likely changed. */
  | { readonly code: 'stored_key_unreadable' }
  | { readonly code: 'validation_failed'; readonly problems: readonly FieldProblem[] }

export type ModelCatalogResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ModelCatalogFailure }

/** One catalog model as the Owner sees it, with its provenance and overrides. */
export interface CatalogEntryView {
  readonly modelId: string
  readonly source: ModelCatalogSource
  readonly excluded: boolean
  /** Per-model capability overrides; null means inherit the connection defaults. */
  readonly overrides: Readonly<Partial<ProviderCapabilities>> | null
  readonly updatedAt: Date
}

/**
 * The synchronization outcome of one connection's catalog. `stale` is true when
 * the last attempt failed after a previous success, which is exactly when the
 * retained catalog is still useful but no longer freshly discovered.
 */
export interface CatalogSyncView {
  readonly syncedAt: Date | null
  readonly lastSuccessAt: Date | null
  readonly lastFailureAt: Date | null
  readonly lastFailureMessage: string | null
  readonly stale: boolean
}

/** The full catalog of one connection: every entry plus its sync state. */
export interface CatalogView {
  readonly sync: CatalogSyncView
  readonly entries: readonly CatalogEntryView[]
}

/** One model an application may list on a connection, before OpenAI shaping. */
export interface ListableModel {
  readonly id: string
  readonly created: number
}

export interface ModelCatalogServiceOptions {
  readonly database: Database
  readonly cipher: SecretCipher
  /** The inference adapter's transport also serves the read-only discovery GET. */
  readonly inference: InferenceAdapter
  readonly clock?: Clock
  /**
   * The Provider Template's known models for a connection's `templateId`.
   * Defaults to no template knowledge until built-in templates exist.
   */
  readonly templateKnowledge?: (templateId: string) => readonly string[] | Promise<readonly string[]>
  /**
   * Whether a connection's `templateId` entitles its Upstream Keys separately.
   * Defaults to `provider`, which is what every Provider did before Key Model
   * Availability existed and what almost every upstream still does.
   */
  readonly templateAvailability?: (templateId: string) => 'provider' | 'key'
  /** Whether a template's Provider implements OpenAI `GET /models`. */
  readonly templateDiscovery?: (templateId: string) => 'supported' | 'best_effort' | 'unsupported'
  /** Optional Provider-specific base path for `GET /models`. */
  readonly templateDiscoveryBasePath?: (templateId: string) => `/${string}` | null
}

/**
 * Builds a `templateKnowledge` function from an Adapter Registry: every
 * built-in template declares the model list it was reviewed against, so the
 * catalog service can fill gaps when discovery returns less or before it has
 * run. Unknown template ids return an empty list rather than throw, because a
 * removed template must never break a previously-created connection's
 * catalog.
 */
export function templateKnowledgeFromRegistry(
  registry: AdapterRegistry,
): (templateId: string) => readonly string[] {
  return (templateId) => registry.providerTemplate(templateId)?.knownModels ?? []
}

/**
 * Reads a Provider Template's model-availability declaration from the Adapter
 * Registry. An unknown template — or one that declares nothing — reads as
 * `provider`, so a removed template can never turn an existing connection into
 * a key-scoped one behind the Owner's back.
 */
export function templateAvailabilityFromRegistry(
  registry: AdapterRegistry,
): (templateId: string) => 'provider' | 'key' {
  return (templateId) => registry.providerTemplate(templateId)?.modelAvailability ?? 'provider'
}

export function templateDiscoveryFromRegistry(
  registry: AdapterRegistry,
): (templateId: string) => 'supported' | 'best_effort' | 'unsupported' {
  return (templateId) => registry.providerTemplate(templateId)?.modelDiscovery ?? 'supported'
}

export function templateDiscoveryBasePathFromRegistry(
  registry: AdapterRegistry,
): (templateId: string) => `/${string}` | null {
  return (templateId) => registry.providerTemplate(templateId)?.modelDiscoveryBasePath ?? null
}

const DISCOVERY_UNREACHABLE = 'the provider could not be reached for model discovery'
const DISCOVERY_UNREADABLE = 'the provider answered model discovery without a usable model list'

/** One Upstream Key's transport for a read-only discovery GET. */
interface DiscoveryTarget {
  readonly keyId: string
  readonly baseUrl: string
  readonly allowInsecureHttp: boolean
  readonly upstreamKey: string
  readonly authHeader: string
  readonly authPrefix: string
  readonly staticHeaders: Readonly<Record<string, string>>
  readonly redirectAllowSameOrigin: boolean
  readonly idempotencyHeader: string
  readonly connectionTimeoutMs: number
  readonly firstByteTimeoutMs: number
  readonly nonStreamingTotalTimeoutMs: number
  readonly streamingIdleTimeoutMs: number
  readonly totalRetryTimeoutMs: number
}

type DiscoveryOutcome =
  | { readonly ok: true; readonly models: readonly string[] }
  | { readonly ok: false; readonly message: string }

const MODEL_ID_MAXIMUM = 128
const CAPABILITY_KEYS = [
  'chat',
  'streaming',
  'tools',
  'structuredOutput',
  'responses',
] as const

/**
 * The explainable cached model catalog of a Provider Connection.
 *
 * The rules that matter live here rather than in the HTTP layer: discovery is a
 * read-only GET over the same adapter the connection uses for inference, a
 * failed refresh always retains the last good catalog and only marks it stale,
 * template knowledge and Owner additions fill gaps that discovery does not
 * cover, and the provider-scoped Models list is shaped from the connection's
 * effective (non-excluded) knowledge. No paid or background probes are ever
 * made: discovery runs only on Owner-visible triggers.
 */
export class ModelCatalogService {
  readonly #database: Database
  readonly #cipher: SecretCipher
  readonly #inference: InferenceAdapter
  readonly #clock: Clock
  readonly #templateKnowledge: (templateId: string) => readonly string[] | Promise<readonly string[]>
  readonly #templateAvailability: (templateId: string) => 'provider' | 'key'
  readonly #templateDiscovery: (templateId: string) => 'supported' | 'best_effort' | 'unsupported'
  readonly #templateDiscoveryBasePath: (templateId: string) => `/${string}` | null

  constructor(options: ModelCatalogServiceOptions) {
    this.#database = options.database
    this.#cipher = options.cipher
    this.#inference = options.inference
    this.#clock = options.clock ?? systemClock
    this.#templateKnowledge = options.templateKnowledge ?? (() => [])
    this.#templateAvailability = options.templateAvailability ?? (() => 'provider')
    this.#templateDiscovery = options.templateDiscovery ?? (() => 'supported')
    this.#templateDiscoveryBasePath = options.templateDiscoveryBasePath ?? (() => null)
  }

  /** The current catalog and sync state of one connection. Read-only. */
  async view(providerId: string): Promise<ModelCatalogResult<CatalogView>> {
    const provider = await this.#database.providers.getProvider(providerId)
    if (provider === null) return failed({ code: 'provider_not_found' })
    await this.#syncTemplateKnowledge(providerId, provider.templateId, this.#clock.now())
    return await this.#viewOf(providerId)
  }

  /**
   * Re-runs discovery and merges its result. An upstream refusal, an unreadable
   * answer, or a network failure is recorded on the sync state Ã¢—‚¬—€ the last
   * successful catalog is retained and merely marked stale Ã¢—‚¬—€ so the Owner sees
   * the truth without inference ever being disabled by it.
   */
  async refresh(providerId: string): Promise<ModelCatalogResult<CatalogView>> {
    const connection = await this.#database.providers.getProvider(providerId)
    if (connection === null) return failed({ code: 'provider_not_found' })
    if (connection.archivedAt !== null) return failed({ code: 'provider_archived' })

    const at = this.#clock.now()
    if (this.#templateDiscovery(connection.templateId ?? '') === 'unsupported') {
      await this.#syncTemplateKnowledge(providerId, connection.templateId, at)
      await this.#database.modelCatalog.putSync({
        providerId,
        syncedAt: at,
        lastSuccessAt: at,
        lastFailureAt: null,
        lastFailureMessage: null,
      })
      await this.#database.audit.record({
        action: 'model_catalog.refreshed',
        outcome: 'success',
        detail: { providerId, source: 'template' },
        at,
      })
      return await this.#viewOf(providerId)
    }

    // A Provider that entitles each Upstream Key separately is discovered once
    // per key: no single key's answer describes the connection, so trusting one
    // would both understate the Model Catalog and leave every other key without
    // a Key Model Availability (ADR-0023).
    const keyScoped = this.#templateAvailability(connection.templateId ?? '') === 'key'
    const targets = await this.#discoveryTargets(providerId, keyScoped)
    if (!targets.ok) return targets
    const discoveryBasePath = this.#templateDiscoveryBasePath(connection.templateId ?? '')
    const discoveryTargets = discoveryBasePath === null
      ? targets.value
      : targets.value.map((target) => ({
          ...target,
          baseUrl: `${new URL(target.baseUrl).origin}${discoveryBasePath}`,
        }))

    const prior = await this.#database.modelCatalog.getSync(providerId)
    const attempts: { readonly keyId: string; readonly outcome: DiscoveryOutcome }[] = []
    for (const target of discoveryTargets) {
      attempts.push({ keyId: target.keyId, outcome: await this.#discover(target) })
    }

    const answered = attempts.filter((attempt) => attempt.outcome.ok)
    if (answered.length === 0) {
      if (this.#templateDiscovery(connection.templateId ?? '') === 'best_effort') {
        await this.#syncTemplateKnowledge(providerId, connection.templateId, at)
        await this.#database.modelCatalog.putSync({
          providerId,
          syncedAt: at,
          lastSuccessAt: at,
          lastFailureAt: null,
          lastFailureMessage: null,
        })
        await this.#database.audit.record({
          action: 'model_catalog.refreshed',
          outcome: 'success',
          detail: { providerId, source: 'template_fallback' },
          at,
        })
        return await this.#viewOf(providerId)
      }
      // Every key refused. Nothing is erased: each retained list is only marked
      // stale, so routing keeps the last answer it had.
      if (keyScoped) {
        for (const attempt of attempts) await this.#database.keyModelAvailability.markStale(attempt.keyId)
      }
      const first = attempts[0]?.outcome
      return await this.#recordedFailure(
        providerId,
        prior,
        at,
        first !== undefined && !first.ok ? first.message : DISCOVERY_UNREACHABLE,
      )
    }

    let discovered: readonly string[]
    if (keyScoped) {
      for (const attempt of attempts) {
        if (attempt.outcome.ok) {
          await this.#database.keyModelAvailability.put({
            keyId: attempt.keyId,
            providerId,
            models: attempt.outcome.models,
            discoveredAt: at,
          })
        } else {
          await this.#database.keyModelAvailability.markStale(attempt.keyId)
        }
      }
      // The Model Catalog is the union across keys, retained lists included, so
      // a model only one key carries stays askable and a key that failed this
      // round does not shrink the catalog.
      const availability = await this.#database.keyModelAvailability.listForProvider(providerId)
      discovered = [...new Set(availability.flatMap((entry) => entry.models))]
    } else {
      discovered = answered[0]?.outcome.ok === true ? answered[0].outcome.models : []
    }

    await this.#database.modelCatalog.syncDiscovered(providerId, discovered, at)
    await this.#syncTemplateKnowledge(providerId, connection.templateId, at)

    // A partly successful round still refreshed the catalog, so the success
    // advances; the failure is recorded beside it rather than instead of it.
    const refused = attempts.find((attempt) => !attempt.outcome.ok)
    const failure = refused === undefined || refused.outcome.ok
      ? null
      : `${refused.outcome.message} (${attempts.length - answered.length} of ${attempts.length} keys)`
    await this.#database.modelCatalog.putSync({
      providerId,
      syncedAt: at,
      lastSuccessAt: at,
      lastFailureAt: failure === null ? null : at,
      lastFailureMessage: failure,
    })
    await this.#database.audit.record({
      action: 'model_catalog.refreshed',
      outcome: 'success',
      detail: { providerId, ...(keyScoped ? { keys: attempts.length, answered: answered.length } : {}) },
      at,
    })

    return await this.#viewOf(providerId)
  }

  /**
   * Discovers Key Model Availability for the Upstream Keys that have none yet,
   * and merges what they carry into the Model Catalog.
   *
   * Called after the Owner adds keys, where the keys without availability are
   * exactly the ones just added — so this costs one discovery GET per new key
   * rather than a full re-read of the connection. It does nothing at all for a
   * Provider whose Upstream Models are not key-scoped, and it never fails the
   * caller: a key left undiscovered is unrestricted, not unusable (ADR-0023).
   */
  async discoverMissingKeys(providerId: string): Promise<void> {
    const connection = await this.#database.providers.getProvider(providerId)
    if (connection === null || connection.archivedAt !== null) return
    if (this.#templateAvailability(connection.templateId ?? '') !== 'key') return

    const known = new Set(
      (await this.#database.keyModelAvailability.listForProvider(providerId)).map((entry) => entry.keyId),
    )
    const targets = await this.#discoveryTargets(providerId, true)
    if (!targets.ok) return
    const missing = targets.value.filter((target) => !known.has(target.keyId))
    if (missing.length === 0) return

    const at = this.#clock.now()
    let discovered = false
    for (const target of missing) {
      const outcome = await this.#discover(target)
      if (!outcome.ok) continue
      await this.#database.keyModelAvailability.put({
        keyId: target.keyId,
        providerId,
        models: outcome.models,
        discoveredAt: at,
      })
      discovered = true
    }
    if (!discovered) return

    // A new key can carry models no existing key does, and those must become
    // askable. The union is taken over every stored availability rather than
    // just the new keys', or this would shrink the catalog to what they carry.
    const availability = await this.#database.keyModelAvailability.listForProvider(providerId)
    const union = [...new Set(availability.flatMap((entry) => entry.models))]
    if (union.length === 0) return
    await this.#database.modelCatalog.syncDiscovered(providerId, union, at)
    await this.#syncTemplateKnowledge(providerId, connection.templateId, at)
  }

  /** One read-only discovery GET against one Upstream Key. Never throws. */
  async #discover(target: DiscoveryTarget): Promise<DiscoveryOutcome> {
    let upstream
    try {
      upstream = await this.#inference.forward({
        baseUrl: target.baseUrl,
        allowInsecureHttp: target.allowInsecureHttp,
        path: '/models',
        method: 'GET',
        body: null,
        headers: {},
        upstreamKey: target.upstreamKey,
        signal: null,
        authHeader: target.authHeader,
        authPrefix: target.authPrefix,
        staticHeaders: target.staticHeaders,
        redirectAllowSameOrigin: target.redirectAllowSameOrigin,
        idempotencyHeader: target.idempotencyHeader,
        idempotencyGenerationSafe: false,
        connectionTimeoutMs: target.connectionTimeoutMs,
        firstByteTimeoutMs: target.firstByteTimeoutMs,
        nonStreamingTotalTimeoutMs: target.nonStreamingTotalTimeoutMs,
        streamingIdleTimeoutMs: target.streamingIdleTimeoutMs,
        totalRetryTimeoutMs: target.totalRetryTimeoutMs,
      })
    } catch {
      return { ok: false, message: DISCOVERY_UNREACHABLE }
    }

    if (upstream.status < 200 || upstream.status >= 300) {
      return { ok: false, message: `the provider refused model discovery (HTTP ${upstream.status})` }
    }

    // Discovery never asks for a stream, so a live body here means an adapter
    // misbehaved; it cannot be parsed as a model list either way.
    if (upstream.kind !== 'buffered') return { ok: false, message: DISCOVERY_UNREADABLE }

    const models = readDiscoveredModels(upstream.body)
    if (models === null) return { ok: false, message: DISCOVERY_UNREADABLE }
    return { ok: true, models }
  }

  /** Names a model the Owner vouches for, even before any discovery reports it. */
  async addOwnerModel(providerId: string, modelId: unknown): Promise<ModelCatalogResult<CatalogView>> {
    const name = modelIdProblems(modelId)
    if (name.problems.length > 0) return failed({ code: 'validation_failed', problems: name.problems })

    const connection = await this.#editableConnection(providerId)
    if (!connection.ok) return connection

    const at = this.#clock.now()
    await this.#database.transaction(async (repositories) => {
      await repositories.modelCatalog.addOwnerModel(providerId, name.value, at)
      await repositories.audit.record({
        action: 'model_catalog.owner_added',
        outcome: 'success',
        detail: { providerId, modelId: name.value },
        at,
      })
    })
    return await this.#viewOf(providerId)
  }

  /** Removes an Owner addition. Unknown models and non-addition rows change nothing. */
  async removeOwnerModel(providerId: string, modelId: string): Promise<ModelCatalogResult<CatalogView>> {
    const connection = await this.#editableConnection(providerId)
    if (!connection.ok) return connection

    const at = this.#clock.now()
    await this.#database.transaction(async (repositories) => {
      const removed = await repositories.modelCatalog.removeOwnerModel(providerId, modelId)
      await repositories.audit.record({
        action: 'model_catalog.owner_removed',
        outcome: removed ? 'success' : 'failure',
        detail: { providerId, modelId, removed },
        at,
      })
    })
    return await this.#viewOf(providerId)
  }

  /** Blocks or unblocks a model. The block survives future discovery. */
  async setExcluded(providerId: string, modelId: string, excluded: boolean): Promise<ModelCatalogResult<CatalogView>> {
    const connection = await this.#editableConnection(providerId)
    if (!connection.ok) return connection

    const at = this.#clock.now()
    await this.#database.transaction(async (repositories) => {
      await repositories.modelCatalog.setExcluded(providerId, modelId, excluded, at)
      await repositories.audit.record({
        action: excluded ? 'model_catalog.excluded' : 'model_catalog.unexcluded',
        outcome: 'success',
        detail: { providerId, modelId },
        at,
      })
    })
    return await this.#viewOf(providerId)
  }

  /** Replaces per-model capability overrides; an unknown model becomes `owner_added`. */
  async updateOverrides(
    providerId: string,
    modelId: string,
    overrides: unknown,
  ): Promise<ModelCatalogResult<CatalogView>> {
    const read = readOverrides(overrides)
    if (!read.ok) return failed({ code: 'validation_failed', problems: read.problems })

    const connection = await this.#editableConnection(providerId)
    if (!connection.ok) return connection

    const at = this.#clock.now()
    await this.#database.transaction(async (repositories) => {
      await repositories.modelCatalog.updateOverrides(providerId, modelId, read.overrides, at)
      await repositories.audit.record({
        action: 'model_catalog.overrides_updated',
        outcome: 'success',
        detail: { providerId, modelId, fields: Object.keys(read.overrides) },
        at,
      })
    })
    return await this.#viewOf(providerId)
  }

  /** Whether the Owner has blocked this model on this connection. */
  async isExcluded(providerId: string, modelId: string): Promise<boolean> {
    return await this.#database.modelCatalog.isExcluded(providerId, modelId)
  }

  /**
   * The exact model IDs one Gateway Key may list on one connection. A scope
   * naming specific models returns exactly those (unknown ones included, since
   * they remain forwardable); an unrestricted scope returns the effective
   * catalog. Owner exclusions are never listed and disabled or archived
   * connections refuse the list like they refuse inference.
   */
  async listForScope(
    providerId: string,
    allowedModels: readonly string[] | null,
  ): Promise<ModelCatalogResult<readonly ListableModel[]>> {
    const connection = await this.#database.providers.getProvider(providerId)
    if (connection === null) return failed({ code: 'provider_not_found' })
    if (connection.archivedAt !== null) return failed({ code: 'provider_archived' })
    if (!connection.enabled) return failed({ code: 'provider_disabled' })

    const entries = await this.#database.modelCatalog.listEntries(providerId)
    const byModel = new Map(entries.map((entry) => [entry.modelId, entry]))
    const excluded = new Set(entries.filter((entry) => entry.excluded).map((entry) => entry.modelId))

    const candidates =
      allowedModels === null
        ? entries.filter((entry) => !entry.excluded).map((entry) => entry.modelId)
        : [...new Set(allowedModels)].filter((modelId) => !excluded.has(modelId))
    candidates.sort()

    return {
      ok: true,
      value: candidates.map((modelId) => {
        const entry = byModel.get(modelId)
        const created =
          entry === undefined
            ? Math.floor(connection.createdAt.getTime() / 1000)
            : Math.floor(entry.createdAt.getTime() / 1000)
        return { id: modelId, created }
      }),
    }
  }

  async #syncTemplateKnowledge(providerId: string, templateId: string | null, at: Date): Promise<void> {
    if (templateId === null) return
    const models = await this.#templateKnowledge(templateId)
    if (models.length === 0) return
    await this.#database.modelCatalog.syncTemplate(providerId, models, at)
  }

  /**
   * The Upstream Keys a read-only discovery GET should run against, and the
   * transport each one uses. A key with its own override URL is discovered
   * against that URL; otherwise the connection base URL is used — the same
   * inheritance inference and the usage poller both follow.
   *
   * `everyKey` asks for one target per non-disabled key, which is what a
   * key-scoped Provider needs. Otherwise only the first is returned, because
   * every key of a provider-scoped Provider would answer identically and a
   * second call would buy nothing.
   */
  async #discoveryTargets(
    providerId: string,
    everyKey: boolean,
  ): Promise<ModelCatalogResult<readonly DiscoveryTarget[]>> {
    const connection = await this.#database.providers.getProvider(providerId)
    if (connection === null) return failed({ code: 'provider_not_found' })

    const usable = (await this.#database.providers.listKeys(providerId)).filter(
      (candidate) => candidate.health !== 'disabled',
    )
    const keys = everyKey ? usable : usable.slice(0, 1)
    if (keys.length === 0) return failed({ code: 'no_eligible_key' })

    let staticHeaders: Readonly<Record<string, string>> = {}
    try {
      const decoded = connection.staticHeadersEncrypted === '[]'
        ? []
        : JSON.parse(await this.#cipher.decrypt(connection.staticHeadersEncrypted)) as unknown
      if (Array.isArray(decoded)) {
        const map: Record<string, string> = {}
        for (const entry of decoded) {
          if (typeof entry !== 'object' || entry === null) continue
          const name = (entry as Record<string, unknown>).name
          const value = (entry as Record<string, unknown>).value
          if (typeof name === 'string' && typeof value === 'string') map[name] = value
        }
        staticHeaders = map
      }
    } catch (cause) {
      if (cause instanceof SecretCipherError) return failed({ code: 'stored_key_unreadable' })
      throw cause
    }

    const targets: DiscoveryTarget[] = []
    for (const key of keys) {
      let upstreamKey: string
      try {
        upstreamKey = await this.#cipher.decrypt(key.encryptedKey)
      } catch (cause) {
        if (!(cause instanceof SecretCipherError)) throw cause
        // One unreadable secret among many must not stop the others; only a
        // connection whose every key is unreadable is genuinely unreadable.
        if (keys.length === 1) return failed({ code: 'stored_key_unreadable' })
        continue
      }

      targets.push({
        keyId: key.id,
        baseUrl: key.baseUrl ?? connection.baseUrl,
        allowInsecureHttp: connection.allowInsecureHttp,
        upstreamKey,
        authHeader: connection.authHeader,
        authPrefix: connection.authPrefix,
        staticHeaders,
        redirectAllowSameOrigin: connection.redirectAllowSameOrigin,
        idempotencyHeader: connection.idempotencyHeader,
        connectionTimeoutMs: connection.connectionTimeoutMs,
        firstByteTimeoutMs: connection.firstByteTimeoutMs,
        nonStreamingTotalTimeoutMs: connection.nonStreamingTotalTimeoutMs,
        streamingIdleTimeoutMs: connection.streamingIdleTimeoutMs,
        totalRetryTimeoutMs: connection.totalRetryTimeoutMs,
      })
    }

    if (targets.length === 0) return failed({ code: 'stored_key_unreadable' })
    return { ok: true, value: targets }
  }

  async #editableConnection(
    providerId: string,
  ): Promise<ModelCatalogResult<ProviderRecord>> {
    const connection = await this.#database.providers.getProvider(providerId)
    if (connection === null) return failed({ code: 'provider_not_found' })
    if (connection.archivedAt !== null) return failed({ code: 'provider_archived' })
    return { ok: true, value: connection }
  }

  async #recordedFailure(
    providerId: string,
    prior: ModelCatalogSyncRecord | null,
    at: Date,
    message: string,
  ): Promise<ModelCatalogResult<CatalogView>> {
    await this.#database.modelCatalog.putSync({
      providerId,
      syncedAt: at,
      lastSuccessAt: prior?.lastSuccessAt ?? null,
      lastFailureAt: at,
      lastFailureMessage: message,
    })
    await this.#database.audit.record({
      action: 'model_catalog.refreshed',
      outcome: 'failure',
      detail: { providerId, message },
      at,
    })
    return await this.#viewOf(providerId)
  }

  async #viewOf(providerId: string): Promise<{ readonly ok: true; readonly value: CatalogView }> {
    const entries = await this.#database.modelCatalog.listEntries(providerId)
    const sync = await this.#database.modelCatalog.getSync(providerId)
    return { ok: true, value: { sync: toSyncView(sync), entries } }
  }
}

/** Reads an OpenAI `data`/`models` list into distinct model IDs, or null. */
function readDiscoveredModels(raw: string): readonly string[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  const list = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : null
  if (list === null) return null

  const ids: string[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const id = (item as Record<string, unknown>).id
    if (typeof id !== 'string') continue
    const modelId = id.trim()
    if (modelId === '' || seen.has(modelId)) continue
    seen.add(modelId)
    ids.push(modelId)
  }

  return ids
}

function toSyncView(sync: ModelCatalogSyncRecord | null): CatalogSyncView {
  const lastSuccessAt = sync?.lastSuccessAt ?? null
  const lastFailureAt = sync?.lastFailureAt ?? null
  const stale =
    lastSuccessAt !== null && lastFailureAt !== null && lastFailureAt.getTime() >= lastSuccessAt.getTime()
  return {
    syncedAt: sync?.syncedAt ?? null,
    lastSuccessAt,
    lastFailureAt,
    lastFailureMessage: sync?.lastFailureMessage ?? null,
    stale,
  }
}

function modelIdProblems(input: unknown): { value: string; problems: readonly FieldProblem[] } {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return { value: '', problems: [{ field: 'modelId', message: 'is required' }] }
  }

  const value = input.trim()
  if (value.length > MODEL_ID_MAXIMUM) {
    return {
      value,
      problems: [{ field: 'modelId', message: `model IDs are at most ${MODEL_ID_MAXIMUM} characters` }],
    }
  }

  return { value, problems: [] }
}

function readOverrides(input: unknown): {
  ok: true
  overrides: Readonly<Partial<ProviderCapabilities>>
} | {
  ok: false
  problems: readonly FieldProblem[]
} {
  if (input === undefined || input === null) return { ok: true, overrides: {} }

  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, problems: [{ field: 'overrides', message: 'must be an object of capability booleans' }] }
  }

  const raw = input as Record<string, unknown>
  const overrides: Record<string, boolean> = {}
  const problems: FieldProblem[] = []
  for (const key of CAPABILITY_KEYS) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value !== 'boolean') {
      problems.push({ field: `overrides.${key}`, message: 'must be a boolean' })
      continue
    }
    overrides[key] = value
  }

  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, overrides: overrides as Partial<ProviderCapabilities> }
}

function failed(failure: ModelCatalogFailure): ModelCatalogResult<never> {
  return { ok: false, failure }
}
