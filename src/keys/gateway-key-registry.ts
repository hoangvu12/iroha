import { randomBytes } from 'node:crypto'
import { hashSecret, randomSecret, secretsMatch } from '../identity/secrets.ts'
import type {
  Database,
  GatewayKeyAccess,
  GatewayKeyRecord,
  GatewayKeyScopeEntry,
} from '../persistence/index.ts'
import { systemClock, type Clock } from '../runtime/clock.ts'

export interface FieldProblem {
  readonly field: string
  readonly message: string
}

export type GatewayKeyFailure =
  | { readonly code: 'gateway_key_not_found' }
  | { readonly code: 'gateway_key_active' }
  | { readonly code: 'gateway_key_revoked' }
  | { readonly code: 'gateway_key_conflict' }
  | { readonly code: 'validation_failed'; readonly problems: readonly FieldProblem[] }

export type GatewayKeyResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: GatewayKeyFailure }

/** What the Owner may see about a Gateway Key. The secret is never here. */
export interface GatewayKeyView {
  readonly id: string
  readonly name: string
  readonly scope: readonly GatewayKeyScopeEntry[]
  readonly access: GatewayKeyAccess
  readonly revision: number
  /** Exact browser origins allowed to use this key; empty disables browser CORS. */
  readonly corsOrigins: readonly string[]
  readonly createdAt: Date
  readonly lastUsedAt: Date | null
  readonly revokedAt: Date | null
}

/** A freshly issued key: the management view plus the one-time usable secret. */
export interface CreatedGatewayKey {
  readonly key: GatewayKeyView
  /** The full credential (`<id>.<secret>`), shown once and then never again. */
  readonly secret: string
}

/** One Provider a calling Gateway Key is permitted to use. */
export interface DirectoryProvider {
  readonly id: string
  readonly handle: string
  readonly displayName: string
  /** The scoped inference URL relative to the installation. */
  readonly url: string
  /** The exact upstream model IDs the scope allows. Empty when none are catalogued. */
  readonly models: readonly string[]
  /** Supported inference capabilities. Empty until the capability work lands. */
  readonly capabilities: Readonly<Record<string, never>>
}

export type DiscoveryResult =
  | { readonly ok: true; readonly value: readonly DirectoryProvider[] }
  | { readonly ok: false }

/**
 * Whether one Gateway Key may drive one provider-scoped inference request.
 * `keyId` names the authenticated key so the routing layer can record which
 * credential served the call.
 */
export type InferenceAuthorization =
  | { readonly ok: true; readonly keyId: string; readonly keyName: string }
  | {
      readonly ok: false
      readonly code: 'gateway_key_invalid' | 'connection_not_allowed' | 'model_not_allowed'
    }

/**
 * Whether one Gateway Key may list models on one provider-scoped connection.
 * The scope's model restriction travels with the success so the route can shape
 * the exact list; `null` means every effective catalog model is listable.
 */
export type ConnectionAuthorization =
  | { readonly ok: true; readonly keyId: string; readonly keyName: string; readonly models: readonly string[] | null }
  | {
      readonly ok: false
      readonly code: 'gateway_key_invalid' | 'connection_not_allowed'
    }

export interface GatewayKeyRegistryOptions {
  readonly database: Database
  readonly clock?: Clock
}

const NAME_MAXIMUM = 128
const MODEL_MAXIMUM = 128

/**
 * Everything Iroha knows about the credentials applications present.
 *
 * The rules that matter live here rather than in the HTTP layer: the usable
 * secret is generated at full entropy and only its hash is stored, the full
 * credential is revealed once on creation, scope is validated against real
 * live connections, discovery is filtered through that scope, and a revoked
 * key and an unknown one are indistinguishable to a caller.
 */
export class GatewayKeyRegistry {
  readonly #database: Database
  readonly #clock: Clock

  constructor(options: GatewayKeyRegistryOptions) {
    this.#database = options.database
    this.#clock = options.clock ?? systemClock
  }

  /** Every key, revoked ones included, most recently created first. */
  async list(): Promise<readonly GatewayKeyView[]> {
    const keys = await this.#database.gatewayKeys.list()
    return keys.map(toView)
  }

  async get(id: string): Promise<GatewayKeyView | null> {
    const key = await this.#database.gatewayKeys.get(id)
    return key === null ? null : toView(key)
  }

  /**
   * Issues one named key. The caller sees the usable credential exactly once;
   * everything stored is its hash, so a database copy cannot be used to call
   * the Gateway.
   */
  async create(input: {
    name: unknown
    scope?: unknown
    access?: unknown
    corsOrigins?: unknown
  }): Promise<GatewayKeyResult<CreatedGatewayKey>> {
    const problems = [...nameProblems(input.name)]
    const access = await readAccess(input.access, input.scope, this.#database, problems)
    const scope = access.mode === 'selected' ? access.providers : []
    const corsOrigins = readCorsOrigins(input.corsOrigins, problems)
    if (problems.length > 0) return failed({ code: 'validation_failed', problems })

    const id = newId()
    const secret = randomSecret()
    const at = this.#clock.now()

    await this.#database.transaction(async (repositories) => {
      await repositories.gatewayKeys.insert({
        id,
        name: (input.name as string).trim(),
        secretHash: hashSecret(secret),
        scope,
        access,
        corsOrigins,
        createdAt: at,
        lastUsedAt: null,
        revokedAt: null,
      })
      await repositories.audit.record({
        action: 'gateway_key.created',
        outcome: 'success',
        // The name is not the secret, and the secret never reaches history.
        detail: { gatewayKeyId: id, name: (input.name as string).trim() },
        at,
      })
    })

    const key = await this.#getOrThrow(id)
    return { ok: true, value: { key, secret: `${id}.${secret}` } }
  }

  /**
   * Replaces the per-key CORS origin list. The Owner can later broaden a key's
   * browser surface; the audit history records the field name only, never the
   * origin strings themselves (which can be hostnames the Owner considers
   * configuration rather than a secret).
   */
  async updateCorsOrigins(
    id: string,
    input: { corsOrigins: unknown },
  ): Promise<GatewayKeyResult<GatewayKeyView>> {
    const key = await this.#database.gatewayKeys.get(id)
    if (key === null) return failed({ code: 'gateway_key_not_found' })

    const problems: FieldProblem[] = []
    const corsOrigins = readCorsOrigins(input.corsOrigins, problems)
    if (problems.length > 0) return failed({ code: 'validation_failed', problems })

    if (
      corsOrigins.length === key.corsOrigins.length &&
      corsOrigins.every((origin, index) => origin === key.corsOrigins[index])
    ) {
      return { ok: true, value: await this.#getOrThrow(id) }
    }

    const at = this.#clock.now()
    await this.#database.transaction(async (repositories) => {
      await repositories.gatewayKeys.updateCorsOrigins(id, corsOrigins, at)
      await repositories.audit.record({
        action: 'gateway_key.configured',
        outcome: 'success',
        detail: { gatewayKeyId: id, fields: ['corsOrigins'] },
        at,
      })
    })

    return { ok: true, value: await this.#getOrThrow(id) }
  }

  /** Atomically replaces every editable setting of one active Gateway Key. */
  async update(
    id: string,
    input: { revision: unknown; name: unknown; access: unknown; corsOrigins: unknown },
  ): Promise<GatewayKeyResult<GatewayKeyView>> {
    const current = await this.#database.gatewayKeys.get(id)
    if (current === null) return failed({ code: 'gateway_key_not_found' })
    if (current.revokedAt !== null) return failed({ code: 'gateway_key_revoked' })

    const problems = [...nameProblems(input.name), ...revisionProblems(input.revision)]
    const access = await readAccess(input.access, undefined, this.#database, problems)
    const corsOrigins = readCorsOrigins(input.corsOrigins, problems)
    if (problems.length > 0) return failed({ code: 'validation_failed', problems })

    const expectedRevision = input.revision as number
    const scope = access.mode === 'selected' ? access.providers : []
    const at = this.#clock.now()
    const updated = await this.#database.transaction(async (repositories) => {
      const saved = await repositories.gatewayKeys.updateActive(
        id,
        expectedRevision,
        { name: (input.name as string).trim(), access, scope, corsOrigins },
        at,
      )
      if (saved === null) return null
      await repositories.audit.record({
        action: 'gateway_key.updated',
        outcome: 'success',
        detail: {
          gatewayKeyId: id,
          before: { name: current.name, access: accessAuditMetadata(accessOf(current)) },
          after: { name: saved.name, access: accessAuditMetadata(accessOf(saved)) },
          revision: saved.revision ?? expectedRevision + 1,
        },
        at,
      })
      return saved
    })

    if (updated === null) {
      const latest = await this.#database.gatewayKeys.get(id)
      if (latest === null) return failed({ code: 'gateway_key_not_found' })
      if (latest.revokedAt !== null) return failed({ code: 'gateway_key_revoked' })
      return failed({ code: 'gateway_key_conflict' })
    }
    return { ok: true, value: toView(updated) }
  }

  /**
   * Revokes a key so it can never authenticate again. Revoking twice changes
   * nothing the second time.
   */
  async revoke(id: string): Promise<GatewayKeyResult<GatewayKeyView>> {
    const key = await this.#database.gatewayKeys.get(id)
    if (key === null) return failed({ code: 'gateway_key_not_found' })

    if (key.revokedAt === null) {
      const at = this.#clock.now()
      await this.#database.transaction(async (repositories) => {
        await repositories.gatewayKeys.revoke(id, at)
        await repositories.audit.record({
          action: 'gateway_key.revoked',
          outcome: 'success',
          detail: { gatewayKeyId: id, name: key.name },
          at,
        })
      })
    }

    return { ok: true, value: await this.#getOrThrow(id) }
  }

  /** Permanently removes a revoked credential while retaining safe audit history. */
  async delete(id: string): Promise<GatewayKeyResult<void>> {
    const key = await this.#database.gatewayKeys.get(id)
    if (key === null) return failed({ code: 'gateway_key_not_found' })
    if (key.revokedAt === null) return failed({ code: 'gateway_key_active' })

    const at = this.#clock.now()
    await this.#database.transaction(async (repositories) => {
      const deleted = await repositories.gatewayKeys.deleteRevoked(id)
      if (!deleted) throw new Error(`Revoked Gateway Key ${id} vanished during deletion`)
      await repositories.audit.record({
        action: 'gateway_key.deleted',
        outcome: 'success',
        detail: { gatewayKeyId: key.id, name: key.name },
        at,
      })
    })
    return { ok: true, value: undefined }
  }

  /**
   * The Provider Directory: which Providers a presented credential may use.
   * A missing, malformed, revoked, or wrong secret all answer the same way, so
   * a caller learns nothing about which keys exist. Only a successful
   * authentication is recorded as a use.
   */
  async discover(token: string): Promise<DiscoveryResult> {
    const key = await this.#locateKey(token)
    if (key === null) return { ok: false }

    await this.#database.gatewayKeys.markUsed(key.id, this.#clock.now())

    const providers: DirectoryProvider[] = []
    const access = accessOf(key)
    const entries = access.mode === 'all'
      ? (await this.#database.providers.listProviders())
          .filter((provider) => provider.enabled && provider.archivedAt === null)
          .map((provider) => ({ providerId: provider.id, models: null }))
      : access.providers
    for (const entry of entries) {
      const provider = await this.#database.providers.getProvider(entry.providerId)
      // An out-of-scope or vanished Provider is absent, never an error: the
      // caller must not learn which Providers exist, only which it may use.
      if (provider === null || provider.archivedAt !== null || !provider.enabled) continue

      const models = key.access?.mode === 'all'
        ? (await this.#database.modelCatalog.listEntries(provider.id))
            .filter((model) => !model.excluded)
            .map((model) => model.modelId)
            .sort()
        : entry.models ?? []
      providers.push({
        id: provider.id,
        handle: provider.handle,
        displayName: provider.displayName,
        url: `/providers/${provider.handle}/v1`,
        // A scope allowing every model has nothing to enumerate until the model
        // catalog exists; exact scope models are returned verbatim.
        models,
        capabilities: {},
      })
    }

    return { ok: true, value: providers }
  }

  /**
   * Authorizes one provider-scoped inference call. The key must be live, the
   * connection must be inside its scope, and the requested model must be one
   * the scope allows. A missing, revoked, or wrong secret is indistinguishable
   * from the discovery failure, so probing cannot learn which keys exist.
   */
  async authorizeInference(
    providerId: string,
    model: string,
    token: string | null,
  ): Promise<InferenceAuthorization> {
    const located = await this.#authorizeScope(providerId, token)
    if (!located.ok) return located

    if (located.models !== null && !located.models.includes(model)) {
      return { ok: false, code: 'model_not_allowed' }
    }

    return { ok: true, keyId: located.keyId, keyName: located.keyName }
  }

  /**
   * Authorizes one provider-scoped Models list. The connection must be inside
   * the key's scope; the scope's exact model restriction (null for every model)
   * is returned so the route can shape the list. Failures are as silent as the
   * inference authorization's.
   */
  async authorizeProvider(
    providerId: string,
    token: string | null,
  ): Promise<ConnectionAuthorization> {
    return await this.#authorizeScope(providerId, token)
  }

  async #authorizeScope(
    providerId: string,
    token: string | null,
  ): Promise<ConnectionAuthorization> {
    const key = await this.#locateKey(token)
    if (key === null) return { ok: false, code: 'gateway_key_invalid' }

    const access = accessOf(key)
    let entry: GatewayKeyScopeEntry | undefined
    if (access.mode === 'all') {
      const provider = await this.#database.providers.getProvider(providerId)
      if (provider === null || provider.archivedAt !== null || !provider.enabled) {
        return { ok: false, code: 'connection_not_allowed' }
      }
      entry = { providerId, models: null }
    } else {
      entry = access.providers.find((candidate) => candidate.providerId === providerId)
    }
    if (entry === undefined) return { ok: false, code: 'connection_not_allowed' }

    await this.#database.gatewayKeys.markUsed(key.id, this.#clock.now())
    return { ok: true, keyId: key.id, keyName: key.name, models: entry.models }
  }

  async #locateKey(token: string | null): Promise<GatewayKeyRecord | null> {
    if (typeof token !== 'string') return null

    const separator = token.indexOf('.')
    if (separator <= 0) return null

    const id = token.slice(0, separator)
    const secret = token.slice(separator + 1)
    if (id === '' || secret === '') return null

    const key = await this.#database.gatewayKeys.get(id)
    if (key === null || key.revokedAt !== null) return null
    if (!secretsMatch(key.secretHash, hashSecret(secret))) return null
    return key
  }

  async #getOrThrow(id: string): Promise<GatewayKeyView> {
    const key = await this.get(id)
    if (key === null) throw new Error(`Gateway Key ${id} vanished mid-operation`)
    return key
  }
}

/**
 * Reads and validates the requested scope against the Providers that exist.
 * Problems are added for every rule broken; the returned entries are only
 * meaningful when the problem list is empty.
 */
async function readAccess(
  input: unknown,
  legacyScope: unknown,
  database: Database,
  problems: FieldProblem[],
): Promise<GatewayKeyAccess> {
  if (input === undefined) {
    return { mode: 'selected', providers: await readScope(legacyScope, database, problems) }
  }
  if (typeof input !== 'object' || input === null) {
    problems.push({ field: 'access', message: 'must describe an access mode' })
    return { mode: 'selected', providers: [] }
  }
  const access = input as Record<string, unknown>
  if (access.mode === 'all') return { mode: 'all' }
  if (access.mode === 'selected') {
    return {
      mode: 'selected',
      providers: await readScope(access.providers, database, problems, 'access'),
    }
  }
  problems.push({ field: 'access', message: 'mode must be all or selected' })
  return { mode: 'selected', providers: [] }
}

async function readScope(
  input: unknown,
  database: Database,
  problems: FieldProblem[],
  field = 'scope',
): Promise<readonly GatewayKeyScopeEntry[]> {
  if (input === undefined || input === null) return []

  if (!Array.isArray(input)) {
    problems.push({ field, message: 'must be a list of Providers' })
    return []
  }

  const entries: GatewayKeyScopeEntry[] = []
  const seen = new Set<string>()

  for (const raw of input) {
    if (typeof raw !== 'object' || raw === null) {
      problems.push({ field, message: 'each entry must name a Provider' })
      continue
    }

    const entry = raw as Record<string, unknown>
    const providerId = typeof entry.providerId === 'string' ? entry.providerId.trim() : ''
    if (providerId === '') {
      problems.push({ field, message: 'each entry must name a Provider' })
      continue
    }
    if (seen.has(providerId)) continue
    seen.add(providerId)

    const scopeProvider = await database.providers.getProvider(providerId)
    if (scopeProvider === null) {
      problems.push({ field, message: 'names a Provider that does not exist' })
      continue
    }
    if (scopeProvider.archivedAt !== null) {
      problems.push({ field, message: 'names a Provider that is archived' })
      continue
    }

    entries.push({ providerId, models: readModels(entry.models, problems) })
  }

  return entries
}

function readModels(input: unknown, problems: FieldProblem[]): readonly string[] | null {
  if (input === undefined || input === null) return null

  if (!Array.isArray(input)) {
    problems.push({ field: 'scope', message: 'allowed models must be a list of exact model IDs' })
    return null
  }

  const models: string[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    if (typeof raw !== 'string') {
      problems.push({ field: 'scope', message: 'allowed model IDs must be text' })
      continue
    }

    const model = raw.trim()
    if (model === '') continue
    if (model.length > MODEL_MAXIMUM) {
      problems.push({ field: 'scope', message: `model IDs are at most ${MODEL_MAXIMUM} characters` })
      continue
    }
    if (seen.has(model)) continue
    seen.add(model)
    models.push(model)
  }

  return models
}

function nameProblems(input: unknown): readonly FieldProblem[] {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return [{ field: 'name', message: 'is required' }]
  }

  if (input.trim().length > NAME_MAXIMUM) {
    return [{ field: 'name', message: `must be at most ${NAME_MAXIMUM} characters` }]
  }

  return []
}

function revisionProblems(input: unknown): readonly FieldProblem[] {
  return Number.isSafeInteger(input) && (input as number) >= 1
    ? []
    : [{ field: 'revision', message: 'must be a positive integer' }]
}

function toView(key: GatewayKeyRecord): GatewayKeyView {
  return {
    id: key.id,
    name: key.name,
    scope: key.scope,
    access: accessOf(key),
    revision: key.revision ?? 1,
    corsOrigins: [...key.corsOrigins],
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    revokedAt: key.revokedAt,
  }
}

function accessOf(key: GatewayKeyRecord): GatewayKeyAccess {
  return key.access ?? { mode: 'selected', providers: key.scope }
}

function accessAuditMetadata(access: GatewayKeyAccess): Readonly<Record<string, unknown>> {
  if (access.mode === 'all') return { mode: 'all' }
  return {
    mode: 'selected',
    providerCount: access.providers.length,
    restrictedProviderCount: access.providers.filter((entry) => entry.models !== null).length,
  }
}

const CORS_ORIGIN_MAXIMUM_ENTRIES = 64

/**
 * Reads and validates the CORS origins list. Each entry must be a parseable
 * exact origin: scheme + host (+ optional port). No wildcards, no paths, no
 * fragment. The list is deduplicated case-sensitively as-is so an explicit
 * `https://Example` and `https://example` are preserved separately; a browser
 * will reject the wrong case.
 */
function readCorsOrigins(input: unknown, problems: FieldProblem[]): readonly string[] {
  if (input === undefined) return []
  if (!Array.isArray(input)) {
    problems.push({ field: 'corsOrigins', message: 'must be a list of exact origin strings' })
    return []
  }

  if (input.length > CORS_ORIGIN_MAXIMUM_ENTRIES) {
    problems.push({
      field: 'corsOrigins',
      message: `holds at most ${CORS_ORIGIN_MAXIMUM_ENTRIES} entries`,
    })
  }

  const origins: string[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    if (typeof raw !== 'string' || raw.length === 0) {
      problems.push({ field: 'corsOrigins', message: 'each origin must be a non-empty string' })
      continue
    }
    if (raw.includes('*')) {
      problems.push({ field: 'corsOrigins', message: 'wildcard origins are not accepted' })
      continue
    }
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      problems.push({ field: 'corsOrigins', message: 'each entry must be an exact origin like https://host' })
      continue
    }
    if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
      problems.push({ field: 'corsOrigins', message: 'each entry must be an origin without a path' })
      continue
    }
    const canonical = parsed.origin
    if (seen.has(canonical)) continue
    seen.add(canonical)
    origins.push(canonical)
  }

  return origins
}

function newId(): string {
  return `gk_${randomBytes(16).toString('base64url')}`
}

function failed(failure: GatewayKeyFailure): GatewayKeyResult<never> {
  return { ok: false, failure }
}
