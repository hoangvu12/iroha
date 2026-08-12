import { SecretCipherError, type SecretCipher } from '../crypto/index.ts'
import type { InferenceAdapter } from '../inference/index.ts'
import type {
  ConnectionCapabilities,
  Database,
  ModelCatalogSource,
  ModelCatalogSyncRecord,
  ProviderConnectionRecord,
} from '../persistence/index.ts'
import { systemClock, type Clock } from '../runtime/clock.ts'

export interface FieldProblem {
  readonly field: string
  readonly message: string
}

export type ModelCatalogFailure =
  | { readonly code: 'connection_not_found' }
  | { readonly code: 'connection_archived' }
  | { readonly code: 'connection_disabled' }
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
  readonly overrides: Readonly<Partial<ConnectionCapabilities>> | null
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
}

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

  constructor(options: ModelCatalogServiceOptions) {
    this.#database = options.database
    this.#cipher = options.cipher
    this.#inference = options.inference
    this.#clock = options.clock ?? systemClock
    this.#templateKnowledge = options.templateKnowledge ?? (() => [])
  }

  /** The current catalog and sync state of one connection. Read-only. */
  async view(connectionId: string): Promise<ModelCatalogResult<CatalogView>> {
    const connection = await this.#database.providers.getConnection(connectionId)
    if (connection === null) return failed({ code: 'connection_not_found' })
    return await this.#viewOf(connectionId)
  }

  /**
   * Re-runs discovery and merges its result. An upstream refusal, an unreadable
   * answer, or a network failure is recorded on the sync state — the last
   * successful catalog is retained and merely marked stale — so the Owner sees
   * the truth without inference ever being disabled by it.
   */
  async refresh(connectionId: string): Promise<ModelCatalogResult<CatalogView>> {
    const connection = await this.#database.providers.getConnection(connectionId)
    if (connection === null) return failed({ code: 'connection_not_found' })
    if (connection.archivedAt !== null) return failed({ code: 'connection_archived' })

    const target = await this.#discoveryTarget(connectionId)
    if (!target.ok) return target

    const prior = await this.#database.modelCatalog.getSync(connectionId)
    const at = this.#clock.now()

    let upstream
    try {
      upstream = await this.#inference.forward({
        baseUrl: target.value.baseUrl,
        allowInsecureHttp: target.value.allowInsecureHttp,
        path: '/models',
        method: 'GET',
        body: null,
        headers: {},
        upstreamKey: target.value.upstreamKey,
        signal: null,
      })
    } catch {
      return await this.#recordedFailure(
        connectionId,
        prior,
        at,
        'the provider could not be reached for model discovery',
      )
    }

    if (upstream.status < 200 || upstream.status >= 300) {
      return await this.#recordedFailure(
        connectionId,
        prior,
        at,
        `the provider refused model discovery (HTTP ${upstream.status})`,
      )
    }

    const discovered = readDiscoveredModels(upstream.body)
    if (discovered === null) {
      return await this.#recordedFailure(
        connectionId,
        prior,
        at,
        'the provider answered model discovery without a usable model list',
      )
    }

    await this.#database.modelCatalog.syncDiscovered(connectionId, discovered, at)
    await this.#syncTemplateKnowledge(connectionId, connection.templateId, at)
    await this.#database.modelCatalog.putSync({
      connectionId,
      syncedAt: at,
      lastSuccessAt: at,
      lastFailureAt: null,
      lastFailureMessage: null,
    })
    await this.#database.audit.record({
      action: 'model_catalog.refreshed',
      outcome: 'success',
      detail: { connectionId },
      at,
    })

    return await this.#viewOf(connectionId)
  }

  /** Names a model the Owner vouches for, even before any discovery reports it. */
  async addOwnerModel(connectionId: string, modelId: unknown): Promise<ModelCatalogResult<CatalogView>> {
    const name = modelIdProblems(modelId)
    if (name.problems.length > 0) return failed({ code: 'validation_failed', problems: name.problems })

    const connection = await this.#editableConnection(connectionId)
    if (!connection.ok) return connection

    await this.#database.modelCatalog.addOwnerModel(connectionId, name.value, this.#clock.now())
    return await this.#viewOf(connectionId)
  }

  /** Removes an Owner addition. Unknown models and non-addition rows change nothing. */
  async removeOwnerModel(connectionId: string, modelId: string): Promise<ModelCatalogResult<CatalogView>> {
    const connection = await this.#editableConnection(connectionId)
    if (!connection.ok) return connection

    await this.#database.modelCatalog.removeOwnerModel(connectionId, modelId)
    return await this.#viewOf(connectionId)
  }

  /** Blocks or unblocks a model. The block survives future discovery. */
  async setExcluded(connectionId: string, modelId: string, excluded: boolean): Promise<ModelCatalogResult<CatalogView>> {
    const connection = await this.#editableConnection(connectionId)
    if (!connection.ok) return connection

    await this.#database.modelCatalog.setExcluded(connectionId, modelId, excluded, this.#clock.now())
    return await this.#viewOf(connectionId)
  }

  /** Replaces per-model capability overrides; an unknown model becomes `owner_added`. */
  async updateOverrides(
    connectionId: string,
    modelId: string,
    overrides: unknown,
  ): Promise<ModelCatalogResult<CatalogView>> {
    const read = readOverrides(overrides)
    if (!read.ok) return failed({ code: 'validation_failed', problems: read.problems })

    const connection = await this.#editableConnection(connectionId)
    if (!connection.ok) return connection

    await this.#database.modelCatalog.updateOverrides(
      connectionId,
      modelId,
      read.overrides,
      this.#clock.now(),
    )
    return await this.#viewOf(connectionId)
  }

  /** Whether the Owner has blocked this model on this connection. */
  async isExcluded(connectionId: string, modelId: string): Promise<boolean> {
    return await this.#database.modelCatalog.isExcluded(connectionId, modelId)
  }

  /**
   * The exact model IDs one Gateway Key may list on one connection. A scope
   * naming specific models returns exactly those (unknown ones included, since
   * they remain forwardable); an unrestricted scope returns the effective
   * catalog. Owner exclusions are never listed and disabled or archived
   * connections refuse the list like they refuse inference.
   */
  async listForScope(
    connectionId: string,
    allowedModels: readonly string[] | null,
  ): Promise<ModelCatalogResult<readonly ListableModel[]>> {
    const connection = await this.#database.providers.getConnection(connectionId)
    if (connection === null) return failed({ code: 'connection_not_found' })
    if (connection.archivedAt !== null) return failed({ code: 'connection_archived' })
    if (!connection.enabled) return failed({ code: 'connection_disabled' })

    const entries = await this.#database.modelCatalog.listEntries(connectionId)
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

  async #syncTemplateKnowledge(connectionId: string, templateId: string | null, at: Date): Promise<void> {
    if (templateId === null) return
    const models = await this.#templateKnowledge(templateId)
    if (models.length === 0) return
    await this.#database.modelCatalog.syncTemplate(connectionId, models, at)
  }

  /** The base URL and one usable Upstream Key for a read-only discovery GET. */
  async #discoveryTarget(
    connectionId: string,
  ): Promise<ModelCatalogResult<{ readonly baseUrl: string; readonly allowInsecureHttp: boolean; readonly upstreamKey: string }>> {
    const connection = await this.#database.providers.getConnection(connectionId)
    if (connection === null) return failed({ code: 'connection_not_found' })

    const key =
      (await this.#database.providers.listKeys(connectionId)).find(
        (candidate) => candidate.health !== 'disabled',
      ) ?? null
    if (key === null) return failed({ code: 'no_eligible_key' })

    try {
      return {
        ok: true,
        value: {
          baseUrl: connection.baseUrl,
          allowInsecureHttp: connection.allowInsecureHttp,
          upstreamKey: await this.#cipher.decrypt(key.encryptedKey),
        },
      }
    } catch (cause) {
      if (cause instanceof SecretCipherError) return failed({ code: 'stored_key_unreadable' })
      throw cause
    }
  }

  async #editableConnection(
    connectionId: string,
  ): Promise<ModelCatalogResult<ProviderConnectionRecord>> {
    const connection = await this.#database.providers.getConnection(connectionId)
    if (connection === null) return failed({ code: 'connection_not_found' })
    if (connection.archivedAt !== null) return failed({ code: 'connection_archived' })
    return { ok: true, value: connection }
  }

  async #recordedFailure(
    connectionId: string,
    prior: ModelCatalogSyncRecord | null,
    at: Date,
    message: string,
  ): Promise<ModelCatalogResult<CatalogView>> {
    await this.#database.modelCatalog.putSync({
      connectionId,
      syncedAt: at,
      lastSuccessAt: prior?.lastSuccessAt ?? null,
      lastFailureAt: at,
      lastFailureMessage: message,
    })
    await this.#database.audit.record({
      action: 'model_catalog.refreshed',
      outcome: 'failure',
      detail: { connectionId, message },
      at,
    })
    return await this.#viewOf(connectionId)
  }

  async #viewOf(connectionId: string): Promise<{ readonly ok: true; readonly value: CatalogView }> {
    const entries = await this.#database.modelCatalog.listEntries(connectionId)
    const sync = await this.#database.modelCatalog.getSync(connectionId)
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
  overrides: Readonly<Partial<ConnectionCapabilities>>
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
  return { ok: true, overrides: overrides as Partial<ConnectionCapabilities> }
}

function failed(failure: ModelCatalogFailure): ModelCatalogResult<never> {
  return { ok: false, failure }
}
