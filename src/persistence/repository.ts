import type { DatabaseDialect } from '../config/environment.ts'

/**
 * The database contract the rest of Iroha may depend on.
 *
 * SQLite and PostgreSQL each carry their own Drizzle schema and migration
 * history. Neither dialect's types appear here, so that a caller cannot come to
 * depend on one engine's behaviour and quietly break the other.
 */

/** A global application setting owned by the database rather than the environment. */
export interface SettingRecord {
  readonly key: string
  readonly value: unknown
  readonly updatedAt: Date
}

export interface SettingsRepository {
  get(key: string): Promise<SettingRecord | null>
  list(): Promise<readonly SettingRecord[]>
  /** Inserts or replaces the setting, returning the stored record. */
  put(key: string, value: unknown): Promise<SettingRecord>
  /** Returns whether a setting existed to remove. */
  remove(key: string): Promise<boolean>
}

/**
 * The primary key of the single Owner row. Both dialects use it so that a
 * second Owner is rejected by the database rather than by application logic.
 */
export const OWNER_ROW_ID = 'owner'

/** The sole Owner of the installation. The password hash never leaves persistence. */
export interface OwnerRecord {
  readonly username: string
  readonly passwordHash: string
  readonly createdAt: Date
  readonly passwordChangedAt: Date
}

export interface OwnerRepository {
  get(): Promise<OwnerRecord | null>
  /**
   * Creates the sole Owner, returning `null` when one already exists.
   *
   * The single-row constraint lives in the database rather than in a
   * read-then-write check, so two concurrent setup attempts cannot both win.
   */
  create(owner: {
    username: string
    passwordHash: string
    at: Date
  }): Promise<OwnerRecord | null>
  /** Replaces the Owner's password hash. Returns `null` when no Owner exists. */
  changePassword(passwordHash: string, at: Date): Promise<OwnerRecord | null>
}

/**
 * One signed-in browser. `secretHash` is the hash of the cookie secret, so a
 * copy of the database cannot be replayed as a session.
 */
export interface SessionRecord {
  readonly id: string
  readonly secretHash: string
  /** Compared against the request's CSRF header; not a bearer credential. */
  readonly csrfToken: string
  readonly createdAt: Date
  readonly lastSeenAt: Date
  readonly expiresAt: Date
  /** A short client description for the Owner's session list, never a secret. */
  readonly userAgent: string | null
}

export interface SessionRepository {
  create(session: SessionRecord): Promise<SessionRecord>
  get(id: string): Promise<SessionRecord | null>
  /** Every session, most recently seen first. */
  list(): Promise<readonly SessionRecord[]>
  /** Slides the idle expiry forward. Returns whether the session still existed. */
  touch(id: string, lastSeenAt: Date, expiresAt: Date): Promise<boolean>
  remove(id: string): Promise<boolean>
  /** Revokes every session, returning how many were removed. */
  removeAll(): Promise<number>
  /** Removes sessions whose expiry has passed, returning how many were removed. */
  removeExpired(now: Date): Promise<number>
}

export type AuditOutcome = 'success' | 'failure'

/**
 * One administrative event, retained until the Owner clears it. `detail` is
 * structured context and never carries a secret value.
 */
export interface AuditEventRecord {
  readonly id: number
  readonly occurredAt: Date
  readonly action: string
  readonly outcome: AuditOutcome
  readonly detail: unknown
}

export interface AuditRepository {
  record(event: {
    action: string
    outcome: AuditOutcome
    detail?: unknown
    at: Date
  }): Promise<AuditEventRecord>
  /** Most recent first. */
  list(options?: { limit?: number }): Promise<readonly AuditEventRecord[]>
}

/**
 * One Owner-configured upstream brand the Gateway reaches. The ID is immutable
 * for the Provider's whole life because client URLs are built on it; every
 * other field may change.
 */
export interface ProviderRecord {
  readonly id: string
  /** Immutable public routing identity. */
  readonly handle: string
  readonly displayName: string
  /** The Provider's default OpenAI-compatible base URL, exactly as the Owner gave it. */
  readonly baseUrl: string
  /** The explicit per-Provider exception that permits plain HTTP. */
  readonly allowInsecureHttp: boolean
  readonly enabled: boolean
  readonly retryMaxAttempts: number
  readonly retryAmbiguousNetwork: boolean
  /** Set when the Provider is archived; null while it is in active use. */
  readonly archivedAt: Date | null
  /**
   * The Provider Template whose defaults seeded this Provider, or null for a
   * hand-configured Provider. Template knowledge contributes catalog models.
   */
  readonly templateId: string | null
  /** Provider-wide capability defaults; per-model overrides may replace them. */
  readonly capabilities: ProviderCapabilities
  /** Canonical authentication header name (e.g. "Authorization", "X-Api-Key"). */
  readonly authHeader: string
  /** Plain-text prefix for the authentication header; empty string means none. */
  readonly authPrefix: string
  /**
   * The stored encrypted blob of the Provider's static headers. Decryption is
   * the registry's responsibility: this column carries cipher output, and the
   * registry surfaces a decrypted `staticHeaders` view to callers.
   */
  readonly staticHeadersEncrypted: string
  /** Whether same-origin redirects are explicitly allowed. */
  readonly redirectAllowSameOrigin: boolean
  /** Per-Provider override for the global connection timeout (ms). */
  readonly connectionTimeoutMs: number
  /** Per-Provider override for the global first-byte timeout (ms). */
  readonly firstByteTimeoutMs: number
  /** Per-Provider override for the global non-streaming total timeout (ms). */
  readonly nonStreamingTotalTimeoutMs: number
  /** Per-Provider override for the global streaming idle timeout (ms). */
  readonly streamingIdleTimeoutMs: number
  /** Per-Provider override for the global total-retry timeout (ms). */
  readonly totalRetryTimeoutMs: number
  /** The idempotency header the adapter accepts (e.g. "Idempotency-Key"). */
  readonly idempotencyHeader: string
  readonly createdAt: Date
  readonly updatedAt: Date
}

/**
 * The inference capabilities a Provider claims by default. Every one is a
 * boolean so the catalog can honestly mark support as unknown-off rather than
 * silently assuming a Provider behaves like a different one.
 */
export interface ProviderCapabilities {
  readonly chat: boolean
  readonly streaming: boolean
  readonly tools: boolean
  readonly structuredOutput: boolean
  readonly responses: boolean
}

/**
 * The durable result of the last low-cost test of an Upstream Key. Reasons are
 * structural descriptions and never contain the key or any secret.
 */
export type KeyProbeVerdict = 'authenticated' | 'rejected' | 'inconclusive'

/**
 * The Key Health states a key can hold before the full Key Health engine
 * exists: Unverified until tested or manually activated, Active once usable,
 * Disabled when the Owner turns it off. Later tickets widen this without
 * renaming it.
 */
export type UpstreamKeyHealth =
  | 'unverified'
  | 'active'
  | 'cooling_down'
  | 'invalid_authentication'
  | 'exhausted'
  | 'disabled'

export type CapacityScopeKind = 'key' | 'account' | 'connection_model' | 'provider' | 'unknown'

/**
 * One Owner-configured group of Upstream Keys that share Provider billing or
 * capacity. Accounts are optional: keys outside an account are independent.
 * Deleting an account ungroups its keys rather than removing them.
 */
export interface UpstreamAccountRecord {
  readonly id: string
  readonly providerId: string
  readonly displayName: string
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** Only fields the Owner may edit on an account. The ID is never patchable. */
export interface UpstreamAccountPatch {
  readonly displayName?: string
}

/**
 * One Upstream Key attached to a Provider. The key material itself appears
 * only as cipher output, so copying the database does not copy the Provider's
 * keys.
 */
export interface UpstreamKeyRecord {
  readonly id: string
  readonly providerId: string
  /** Per-Key override of the Provider's base URL; null means inherit the Provider's. */
  readonly baseUrl: string | null
  readonly encryptedKey: string
  readonly health: UpstreamKeyHealth
  readonly lastProbeAt: Date | null
  readonly lastProbeVerdict: KeyProbeVerdict | null
  readonly lastProbeReason: string | null
  readonly healthReason: string | null
  readonly healthChangedAt: Date
  readonly retryAfterAt: Date | null
  readonly healthScope: CapacityScopeKind
  readonly healthScopeId: string | null
  readonly healthModel: string | null
  /**
   * The Upstream Account the key shares billing or capacity with, or null when
   * the key is independent.
   */
  readonly accountId: string | null
  /** Exact models the key may serve, or null for every Provider model. */
  readonly allowedModels: readonly string[] | null
  /** Exact models the key never serves, or null for no exclusion. */
  readonly deniedModels: readonly string[] | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** Only fields the Owner may edit. The ID is never patchable. */
export interface ProviderPatch {
  readonly displayName?: string
  readonly baseUrl?: string
  readonly allowInsecureHttp?: boolean
  readonly enabled?: boolean
  readonly retryMaxAttempts?: number
  readonly retryAmbiguousNetwork?: boolean
  readonly archivedAt?: Date | null
  /** Replaces the Provider-wide capability defaults. */
  readonly capabilities?: ProviderCapabilities
  /** Replaces the canonical authentication header name. */
  readonly authHeader?: string
  /** Replaces the authentication header prefix. */
  readonly authPrefix?: string
  /** Replaces the encrypted static headers blob (already encrypted by the caller). */
  readonly staticHeadersEncrypted?: string
  /** Replaces the same-origin redirect flag. */
  readonly redirectAllowSameOrigin?: boolean
  /** Per-Provider override for the global connection timeout (ms). */
  readonly connectionTimeoutMs?: number
  /** Per-Provider override for the global first-byte timeout (ms). */
  readonly firstByteTimeoutMs?: number
  /** Per-Provider override for the global non-streaming total timeout (ms). */
  readonly nonStreamingTotalTimeoutMs?: number
  /** Per-Provider override for the global streaming idle timeout (ms). */
  readonly streamingIdleTimeoutMs?: number
  /** Per-Provider override for the global total-retry timeout (ms). */
  readonly totalRetryTimeoutMs?: number
  /** Replaces the idempotency header the adapter accepts. */
  readonly idempotencyHeader?: string
}

export interface UpstreamKeyPatch {
  readonly health?: UpstreamKeyHealth
  readonly lastProbeAt?: Date | null
  readonly lastProbeVerdict?: KeyProbeVerdict | null
  readonly lastProbeReason?: string | null
  readonly healthReason?: string | null
  readonly healthChangedAt?: Date
  readonly retryAfterAt?: Date | null
  readonly healthScope?: CapacityScopeKind
  readonly healthScopeId?: string | null
  readonly healthModel?: string | null
  /** Moves the key into an Upstream Account, or back to independence. */
  readonly accountId?: string | null
  /** Replaces the exact-model allow list; null means every model is allowed. */
  readonly allowedModels?: readonly string[] | null
  /** Replaces the exact-model deny list; null means nothing is excluded. */
  readonly deniedModels?: readonly string[] | null
  /**
   * Replaces the per-Key base URL override; null clears the override so the
   * Key inherits the Provider's default base URL.
   */
  readonly baseUrl?: string | null
}

export interface ProviderRepository {
  /** Every Provider, most recently created first, archived ones included. */
  listProviders(): Promise<readonly ProviderRecord[]>
  getProvider(id: string): Promise<ProviderRecord | null>
  /** Resolves the immutable public routing identity to its Provider. */
  getProviderByHandle(handle: string): Promise<ProviderRecord | null>
  insertProvider(provider: ProviderRecord): Promise<ProviderRecord>
  /** Applies only the supplied fields and moves `updatedAt`. Null when unknown. */
  updateProvider(
    id: string,
    patch: ProviderPatch,
    at: Date,
  ): Promise<ProviderRecord | null>
  /** Returns whether a Provider existed to remove. */
  deleteProvider(id: string): Promise<boolean>

  /** Keys of one Provider, oldest first. */
  listKeys(providerId: string): Promise<readonly UpstreamKeyRecord[]>
  getKey(id: string): Promise<UpstreamKeyRecord | null>
  insertKey(key: UpstreamKeyRecord): Promise<UpstreamKeyRecord>
  /** Applies only the supplied fields and moves `updatedAt`. Null when unknown. */
  updateKey(id: string, patch: UpstreamKeyPatch, at: Date): Promise<UpstreamKeyRecord | null>
  /** Removes one key. Returns whether a key existed to remove. */
  deleteKey(id: string): Promise<boolean>
  /** Removes every key of a Provider, returning how many were removed. */
  deleteKeysForProvider(providerId: string): Promise<number>

  /** Accounts of one Provider, oldest first. */
  listAccounts(providerId: string): Promise<readonly UpstreamAccountRecord[]>
  getAccount(id: string): Promise<UpstreamAccountRecord | null>
  insertAccount(account: UpstreamAccountRecord): Promise<UpstreamAccountRecord>
  /** Applies only the supplied fields and moves `updatedAt`. Null when unknown. */
  updateAccount(
    id: string,
    patch: UpstreamAccountPatch,
    at: Date,
  ): Promise<UpstreamAccountRecord | null>
  /**
   * Removes an account, leaving its keys independent. The `set null` foreign
   * key does the ungrouping, so a single delete cannot strand a key in a
   * vanished account.
   */
  deleteAccount(id: string): Promise<boolean>

  /**
   * Resolves the base URL one upstream call should hit. The Key's `baseUrl`
   * wins when set; otherwise the Key inherits the Provider's default. Returns
   * `null` when the Provider does not exist, so callers can report the missing
   * Provider without having to look it up separately.
   */
  providerDefaultBaseUrl(providerId: string, keyId: string): Promise<string | null>
}

/**
 * One Provider a Gateway Key permits its application to use and discover.
 * `models` is `null` when every model on the Provider is allowed, or the exact
 * upstream model IDs the key is restricted to.
 */
export interface GatewayKeyScopeEntry {
  readonly providerId: string
  readonly models: readonly string[] | null
}

export type GatewayKeyAccess =
  | { readonly mode: 'all' }
  | { readonly mode: 'selected'; readonly providers: readonly GatewayKeyScopeEntry[] }

/**
 * One decrypted static header the adapter will merge into every upstream
 * request. `name` is canonicalised; `value` is the Owner's cleartext. The pair
 * travels decrypted through `InferenceTarget` and is encrypted before the
 * registry writes it; the database stores only cipher output.
 */
export interface ProviderStaticHeader {
  readonly name: string
  readonly value: string
}

/**
 * One application credential. The usable secret never reaches storage: only the
 * hash of the high-entropy secret part is kept, and the full credential the
 * application presents is `<id>.<secret>`, revealed once on creation.
 */
export interface GatewayKeyRecord {
  /** The public lookup identity, safe to show in lists and logs. */
  readonly id: string
  readonly name: string
  /** SHA-256 of the secret half of the credential, never the plaintext. */
  readonly secretHash: string
  /** Which Providers the key may use and discover, and how. */
  readonly scope: readonly GatewayKeyScopeEntry[]
  readonly access?: GatewayKeyAccess
  /** Monotonic edit precondition; legacy rows start at one. */
  readonly revision?: number
  /** Exact browser origins allowed to use this key; empty disables browser CORS. */
  readonly corsOrigins: readonly string[]
  readonly createdAt: Date
  /** The last time the key successfully authenticated a caller. */
  readonly lastUsedAt: Date | null
  /** Set once the Owner revokes the key; revoked keys never authenticate. */
  readonly revokedAt: Date | null
}

export interface GatewayKeyRepository {
  /** Every key, most recently created first, revoked ones included. */
  list(): Promise<readonly GatewayKeyRecord[]>
  get(id: string): Promise<GatewayKeyRecord | null>
  insert(key: GatewayKeyRecord): Promise<GatewayKeyRecord>
  /** Records that a key authenticated. Returns whether the key still existed. */
  markUsed(id: string, at: Date): Promise<boolean>
  /** Revokes the key. Returns `null` when no such key exists. */
  revoke(id: string, at: Date): Promise<GatewayKeyRecord | null>
  /** Permanently removes a revoked key. Returns false when it is active or absent. */
  deleteRevoked(id: string): Promise<boolean>
  /** Atomically edits an active key when its revision still matches. */
  updateActive(
    id: string,
    expectedRevision: number,
    patch: {
      readonly name: string
      readonly access: GatewayKeyAccess
      readonly scope: readonly GatewayKeyScopeEntry[]
      readonly corsOrigins: readonly string[]
    },
    at: Date,
  ): Promise<GatewayKeyRecord | null>
  /** Replaces the per-key CORS origins. Returns `null` when no such key exists. */
  updateCorsOrigins(id: string, origins: readonly string[], at: Date): Promise<GatewayKeyRecord | null>
}

/**
 * Where a catalog model's knowledge came from. `excluded` marks an Owner block
 * of a model Iroha otherwise has no knowledge of; the model stays listed so the
 * exclusion can be reviewed and lifted.
 */
export type ModelCatalogSource = 'discovered' | 'template' | 'owner_added' | 'excluded'

/**
 * One model in a Provider's catalog. Excluded rows are kept so Owner intent
 * survives synchronization, but they never join the effective catalog.
 */
export interface ModelCatalogEntryRecord {
  readonly providerId: string
  readonly modelId: string
  readonly source: ModelCatalogSource
  readonly excluded: boolean
  /** Per-model capability overrides; null means inherit the Provider defaults. */
  readonly overrides: Readonly<Partial<ProviderCapabilities>> | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

/**
 * The synchronization outcome of a Provider's catalog. `lastSuccessAt` is
 * retained across failures, which is what lets a failed refresh leave the last
 * good catalog in place and only mark it stale.
 */
export interface ModelCatalogSyncRecord {
  readonly providerId: string
  /** The last time a synchronization was attempted, successful or not. */
  readonly syncedAt: Date | null
  readonly lastSuccessAt: Date | null
  readonly lastFailureAt: Date | null
  /** A structural description, never free upstream text that could echo a secret. */
  readonly lastFailureMessage: string | null
}

export interface ModelCatalogRepository {
  /** Every catalog row of one Provider, insertion order. */
  listEntries(providerId: string): Promise<readonly ModelCatalogEntryRecord[]>
  /**
   * Replaces the Provider's discovered knowledge. Newly discovered models are
   * upserted, existing overrides and exclusions are kept, and discovered models
   * no longer seen are removed — unless the Owner excluded them, so a block
   * survives a discovery that stops reporting the model.
   */
  syncDiscovered(providerId: string, modelIds: readonly string[], at: Date): Promise<void>
  /**
   * Contributes the Provider Template's known models to the catalog. Only
   * absent models are added (source `template`); an existing row and an Owner
   * exclusion are never disturbed, so template knowledge fills gaps without
   * overriding discovery, additions, or intent.
   */
  syncTemplate(providerId: string, modelIds: readonly string[], at: Date): Promise<void>
  /** Marks a model as an Owner addition. Unknown models become `owner_added`. */
  addOwnerModel(providerId: string, modelId: string, at: Date): Promise<void>
  /** Removes an Owner addition. Returns whether an owner-added row was removed. */
  removeOwnerModel(providerId: string, modelId: string): Promise<boolean>
  /** Blocks or unblocks a model. Unblocking an unknown blocked model removes it. */
  setExcluded(providerId: string, modelId: string, excluded: boolean, at: Date): Promise<void>
  /** Replaces per-model overrides, creating an owner-added row when absent. */
  updateOverrides(
    providerId: string,
    modelId: string,
    overrides: Readonly<Partial<ProviderCapabilities>>,
    at: Date,
  ): Promise<void>
  /** Whether the Owner has blocked this model on this Provider. */
  isExcluded(providerId: string, modelId: string): Promise<boolean>
  getSync(providerId: string): Promise<ModelCatalogSyncRecord | null>
  putSync(record: ModelCatalogSyncRecord): Promise<void>
}

/**
 * The durable state of one Provider's Usage Adapter polling. `result` is the
 * last successful normalized reading kept across failures; the failure fields
 * describe the latest poll attempt separately so the UI can render both.
 */
export interface UsageSnapshotRecord {
  readonly providerId: string
  /** The visibility declared by the configured Usage Adapter. */
  readonly visibility: 'reactive_only' | 'authoritative'
  readonly syncedAt: Date | null
  readonly lastSuccessAt: Date | null
  readonly lastFailureAt: Date | null
  /** A structural code from the latest failure, when one happened. */
  readonly lastFailureCode: string | null
  /** A safe structural message from the latest failure, never upstream text. */
  readonly lastFailureMessage: string | null
  /**
   * The JSON-encoded last successful reading, or null when no poll has ever
   * succeeded or the last successful reading has been forgotten.
   */
  readonly result: unknown
}

export interface UsageRepository {
  get(providerId: string): Promise<UsageSnapshotRecord | null>
  /**
   * Replaces the snapshot. The service passes the full record so the
   * repository never has to guess whether an absent field means "stale" or
   * "never polled".
   */
  put(record: UsageSnapshotRecord): Promise<void>
}

export type RequestOutcome = 'success' | 'failure'
export type RequestLifecycle = 'in_progress' | 'completed' | 'abandoned'

/**
 * The persistent shape of one inference call. No prompts, no responses, no
 * upstream headers, no secrets. The ID is the same correlation ID the caller
 * received; `keyId` and `gatewayKeyId` are public identities, not material.
 */
export interface RequestEventRecord {
  readonly id: string
  /** Internal lifecycle. Owner-facing reads expose completed Requests only. */
  readonly lifecycle?: RequestLifecycle
  readonly occurredAt: Date
  readonly providerId: string
  /** Immutable public routing identity captured when the Request is admitted. */
  readonly providerHandle?: string | null
  readonly model: string
  readonly gatewayKeyId: string | null
  /** Immutable display-name snapshot retained if the live Gateway Key is deleted. */
  readonly gatewayKeyName?: string | null
  readonly keyId: string | null
  readonly status: number
  readonly outcome: RequestOutcome
  readonly latencyMs: number
  readonly isStreaming: boolean
  readonly promptTokens: number | null
  readonly completionTokens: number | null
  readonly totalTokens: number | null
  readonly errorCode: string | null
}

export type AttemptOutcome = 'success' | 'failure' | 'skipped'

/**
 * One upstream call inside an inference request. `keyId` is null when the
 * attempt had no eligible key to try; `outcome` is then `skipped`.
 */
export interface RequestAttemptRecord {
  readonly id: number
  readonly requestId: string
  readonly attemptNumber: number
  readonly keyId: string | null
  readonly startedAt: Date
  readonly completedAt: Date | null
  readonly status: number | null
  readonly outcome: AttemptOutcome
  readonly errorCode: string | null
  readonly retryAfterSeconds: number | null
  /** Bounded allow-listed Provider facts; never raw response content. */
  readonly diagnostics: import('../providers/provider-evidence.ts').ProviderDiagnostics
}

export type RequestAttemptInput = Omit<RequestAttemptRecord, 'id' | 'diagnostics'> & {
  readonly diagnostics?: unknown
}

/**
 * The filters the Owner may apply to the request-history list. Empty values
 * mean "do not filter on this field".
 */
export interface RequestHistoryFilter {
  readonly providerId?: string
  readonly outcome?: RequestOutcome
  readonly model?: string
  readonly keyId?: string
  /** Only events strictly after this moment (inclusive). */
  readonly after?: Date
  /** Only events strictly before this moment (exclusive). */
  readonly before?: Date
}

export interface RequestHistoryListOptions {
  readonly filter?: RequestHistoryFilter
  /** Maximum number of events to return; defaults to a reasonable page size. */
  readonly limit?: number
  /** Number of events to skip; used together with a stable order to paginate. */
  readonly offset?: number
}

export interface RequestHistoryListResult {
  readonly events: readonly RequestEventRecord[]
  /** Total rows that match the filter, ignoring `limit` and `offset`. */
  readonly total: number
}

/**
 * Read-only filter and pagination query for the audit feed. Empty values
 * mean "do not filter on this field". `actionPrefix` matches the start of
 * the action name, so the Owner can ask for everything under `key.*`.
 */
export interface AuditFilter {
  readonly actionPrefix?: string
  readonly outcome?: AuditOutcome
  readonly after?: Date
  readonly before?: Date
}

export interface AuditListOptions {
  readonly filter?: AuditFilter
  readonly limit?: number
  readonly offset?: number
}

export interface AuditListResult {
  readonly events: readonly AuditEventRecord[]
  readonly total: number
}

export interface RequestHistoryRepository {
  /**
   * Records the final outcome of one inference call. The caller passes the
   * completed event; the repository never guesses at missing fields.
   * Records with the same `id` overwrite earlier ones so a streaming request
   * whose final tokens arrive later can update its usage numbers without
   * creating a duplicate event.
   */
  recordEvent(event: RequestEventRecord): Promise<void>

  /**
   * Records one attempt within an inference call. The repository returns
   * the assigned row id so the caller can update the same row when the
   * attempt finishes. The caller writes a `null` `completedAt` at start and
   * the final attempt outcome by `updateAttempt`.
   */
  recordAttempt(attempt: RequestAttemptInput): Promise<RequestAttemptRecord>

  /** Patches the outcome of a previously recorded attempt. */
  updateAttempt(
    id: number,
    patch: {
      readonly completedAt: Date
      readonly status: number | null
      readonly outcome: AttemptOutcome
      readonly errorCode: string | null
      readonly retryAfterSeconds: number | null
      readonly diagnostics?: unknown
    },
  ): Promise<void>

  /** Returns one event with its attempts in attempt-number order. */
  getEvent(id: string): Promise<RequestEventRecord | null>
  getAttempts(requestId: string): Promise<readonly RequestAttemptRecord[]>

  /**
   * Filters and paginates events. The order is most-recent-first; ties on
   * `occurredAt` are broken by `id` so pagination is stable even when two
   * requests happened in the same millisecond.
   */
  listEvents(options?: RequestHistoryListOptions): Promise<RequestHistoryListResult>

  /** Marks unfinished Requests older than the cutoff as abandoned. */
  abandonRequests(before: Date): Promise<number>

  /** Removes events that occurred strictly before `before`. */
  pruneEvents(before: Date): Promise<number>

  /**
   * Removes at most `limit` events that occurred strictly before `before`,
   * returning the number actually removed. The bounded form lets the
   * background retention job cooperate with the database instead of taking
   * the lock for one giant DELETE.
   */
  pruneEventsBounded(before: Date, limit: number): Promise<number>

  /** Audit listing with the same kind of pagination as request history. */
  listAudit(options?: AuditListOptions): Promise<AuditListResult>

  /** Removes every audit event; used by the Owner's clear-audit action. */
  clearAudit(): Promise<number>
}

/** The repositories reachable inside and outside a transaction alike. */
export interface Repositories {
  readonly settings: SettingsRepository
  readonly owner: OwnerRepository
  readonly sessions: SessionRepository
  readonly audit: AuditRepository
  readonly providers: ProviderRepository
  readonly gatewayKeys: GatewayKeyRepository
  readonly modelCatalog: ModelCatalogRepository
  readonly usage: UsageRepository
  readonly requestHistory: RequestHistoryRepository
  readonly backgroundJobs: BackgroundJobRepository
}

/**
 * Lifecycle states of one background job. `running` is the in-flight state;
 * `succeeded` and `failed` are terminal states the scheduler writes once a
 * run finishes. `idle` is the initial state before any run has happened.
 */
export type BackgroundJobStatus = 'idle' | 'running' | 'succeeded' | 'failed'

/**
 * The durable status of one background job. `lastStartedAt` and
 * `lastCompletedAt` are kept independently so the Owner can see when a job
 * last began and when it finished — they are not the same timestamp when a
 * job is still running. `lastErrorMessage` is a structural description, never
 * upstream body content that could echo a secret.
 */
export interface BackgroundJobRecord {
  readonly jobId: string
  readonly lastStartedAt: Date | null
  readonly lastCompletedAt: Date | null
  readonly status: BackgroundJobStatus
  readonly lastOutcome: 'success' | 'failure' | null
  readonly lastErrorCode: string | null
  readonly lastErrorMessage: string | null
  readonly lastDurationMs: number | null
  readonly lastAffectedCount: number | null
  readonly updatedAt: Date
}

/**
 * The patch applied to a job's status row when a run finishes. The scheduler
 * supplies the outcome and any error context; only the supplied fields are
 * written, so a stale `lastDurationMs` is not overwritten by a missing one.
 */
export interface BackgroundJobCompletion {
  readonly completedAt: Date
  readonly status: Exclude<BackgroundJobStatus, 'running' | 'idle'>
  readonly outcome: 'success' | 'failure'
  readonly errorCode?: string | null
  readonly errorMessage?: string | null
  readonly durationMs: number
  readonly affectedCount?: number | null
}

/**
 * The durable status of the bounded background jobs the scheduler runs.
 *
 * The contract covers the lifecycle that keeps the Owner's visibility honest
 * without ever letting two concurrent invocations of the same job silently
 * double-write. `tryClaim` is the only way to move a job from `idle` or
 * `succeeded` or `failed` into `running`, and it is atomic: two callers that
 * race against the same job see exactly one winner.
 */
export interface BackgroundJobRepository {
  /**
   * Initial idles every known job, used during startup so the Owner never
   * sees a stale `running`. Returns the number of rows that were moved from
   * `running` back to `idle` so tests can prove the call did anything.
   */
  resetRunning(): Promise<number>
  /**
   * Creates a row for `jobId` if one does not already exist. The default
   * status is `idle` and the `updatedAt` is `at`. The scheduler calls this on
   * every startup so the Owner's job list never collapses to empty rows
   * just because a job has never run.
   */
  ensureIdle(jobId: string, at: Date): Promise<BackgroundJobRecord>
  get(jobId: string): Promise<BackgroundJobRecord | null>
  list(): Promise<readonly BackgroundJobRecord[]>
  /**
   * Atomically marks the job as `running` from a non-running state. Returns
   * the started-at timestamp on success, or `null` when another caller
   * already holds the claim (or when the job is unknown).
   */
  tryClaim(jobId: string, startedAt: Date): Promise<Date | null>
  /**
   * Writes the terminal status of a run, including any failure context. The
   * caller is the one that just won `tryClaim`, so the row is updated
   * unconditionally.
   */
  recordCompletion(jobId: string, completion: BackgroundJobCompletion): Promise<BackgroundJobRecord>
}

export interface Database extends Repositories {
  readonly dialect: DatabaseDialect
  /** A value-free description of the connection target, safe to log. */
  readonly describe: string

  /** Applies every pending migration. Rejects if any migration fails. */
  migrate(): Promise<void>

  /** Rejects when the database is unreachable. Used by readiness. */
  ping(): Promise<void>

  /**
   * Runs `work` atomically. A rejection rolls the transaction back and
   * propagates, so callers never observe a partially applied change.
   */
  transaction<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>

  close(): Promise<void>
}

/** Raised when the configured database cannot be opened or migrated. */
export class DatabaseUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'DatabaseUnavailableError'
  }
}
