import { join } from 'node:path'
import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, lte, ne, sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import type { PostgresConfiguration } from '../../config/environment.ts'
import {
  DatabaseUnavailableError,
  OWNER_ROW_ID,
  type AttemptOutcome,
  type AuditEventRecord,
  type AuditFilter,
  type AuditListOptions,
  type AuditListResult,
  type AuditOutcome,
  type AuditRepository,
  type BackgroundJobCompletion,
  type BackgroundJobRecord,
  type BackgroundJobRepository,
  type BackgroundJobStatus,
  type ProviderCapabilities,
  type Database,
  type GatewayKeyRecord,
  type GatewayKeyRepository,
  type GatewayKeyScopeEntry,
  type KeyProbeVerdict,
  type ModelCatalogEntryRecord,
  type ModelCatalogRepository,
  type ModelCatalogSource,
  type ModelCatalogSyncRecord,
  type OwnerRecord,
  type OwnerRepository,
  type ProviderPatch,
  type ProviderRecord,
  type ProviderRepository,
  type Repositories,
  type RequestAttemptRecord,
  type RequestAttemptInput,
  type RequestEventRecord,
  type RequestHistoryFilter,
  type RequestHistoryListOptions,
  type RequestHistoryListResult,
  type RequestHistoryRepository,
  type RequestOutcome,
  type SessionRecord,
  type SessionRepository,
  type SettingRecord,
  type SettingsRepository,
  type UpstreamAccountPatch,
  type UpstreamAccountRecord,
  type UpstreamKeyHealth,
  type UpstreamKeyPatch,
  type UpstreamKeyRecord,
  type UsageRepository,
  type UsageSnapshotRecord,
} from '../repository.ts'
import { providerDiagnosticsOf } from '../../providers/provider-evidence.ts'
import {
  auditEvents,
  backgroundJobs,
  gatewayKeys,
  modelCatalogEntries,
  modelCatalogSync,
  owner,
  ownerSessions,
  providers,
  requestAttempts,
  requestEvents,
  settings,
  upstreamAccounts,
  upstreamKeys,
  usageSnapshots,
} from './schema.ts'

const MIGRATIONS_FOLDER = join(import.meta.dir, '../../../migrations/postgres')

type Handle = NodePgDatabase<Record<string, never>>

export function openPostgresDatabase(config: PostgresConfiguration): Database {
  const pool = new Pool({ connectionString: config.url })

  // An idle-client error would otherwise reach the process as an unhandled
  // 'error' event and stop Iroha during a routine upstream restart. Readiness
  // reports the outage instead.
  pool.on('error', () => undefined)

  return new PostgresDatabase(config, pool, drizzle(pool))
}

class PostgresDatabase implements Database {
  readonly dialect = 'postgres' as const
  readonly describe: string
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

  constructor(
    config: PostgresConfiguration,
    private readonly pool: Pool,
    private readonly handle: Handle,
  ) {
    this.describe = config.describe
    this.settings = new PostgresSettingsRepository(handle)
    this.owner = new PostgresOwnerRepository(handle)
    this.sessions = new PostgresSessionRepository(handle)
    this.audit = new PostgresAuditRepository(handle)
    this.providers = new PostgresProviderRepository(handle)
    this.gatewayKeys = new PostgresGatewayKeyRepository(handle)
    this.modelCatalog = new PostgresModelCatalogRepository(handle)
    this.usage = new PostgresUsageRepository(handle)
    this.requestHistory = new PostgresRequestHistoryRepository(handle)
    this.backgroundJobs = new PostgresBackgroundJobRepository(handle)
  }

  async migrate(): Promise<void> {
    try {
      await migrate(this.handle, { migrationsFolder: MIGRATIONS_FOLDER })
    } catch (cause) {
      throw new DatabaseUnavailableError(`Migrating ${this.describe} failed`, { cause })
    }
  }

  async ping(): Promise<void> {
    try {
      await this.handle.execute(sql`select 1`)
    } catch (cause) {
      throw new DatabaseUnavailableError(`${this.describe} is not responding`, { cause })
    }
  }

  transaction<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    // The transaction's own client must serve every repository, or a write
    // inside `work` would escape the rollback.
    return this.handle.transaction((tx) =>
      work({
        settings: new PostgresSettingsRepository(tx),
        owner: new PostgresOwnerRepository(tx),
        sessions: new PostgresSessionRepository(tx),
        audit: new PostgresAuditRepository(tx),
        providers: new PostgresProviderRepository(tx),
        gatewayKeys: new PostgresGatewayKeyRepository(tx),
        modelCatalog: new PostgresModelCatalogRepository(tx),
        usage: new PostgresUsageRepository(tx),
        requestHistory: new PostgresRequestHistoryRepository(tx),
        backgroundJobs: new PostgresBackgroundJobRepository(tx),
      }),
    )
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

class PostgresSettingsRepository implements SettingsRepository {
  constructor(private readonly handle: Handle) {}

  async get(key: string): Promise<SettingRecord | null> {
    const [row] = await this.handle.select().from(settings).where(eq(settings.key, key)).limit(1)
    return row ? toRecord(row) : null
  }

  async list(): Promise<readonly SettingRecord[]> {
    const rows = await this.handle.select().from(settings).orderBy(settings.key)
    return rows.map(toRecord)
  }

  async put(key: string, value: unknown): Promise<SettingRecord> {
    // The settings.value column is `jsonb NOT NULL`. The sqlite track wraps
    // every value through `JSON.stringify` so `null` becomes the JSON literal
    // `null` (round-tripped via JSON.parse on read). This track does the same:
    // pass the JSON-encoded form in, and let postgres parse it back into a
    // native jsonb value. The column is NOT NULL, so we never write the SQL
    // `NULL`; the value is always a non-null string that parses to whatever
    // the caller wanted (including the JSON literal `null`).
    const encoded = JSON.stringify(value ?? null)
    const row = { key, value: encoded, updatedAt: new Date() }

    const [stored] = await this.handle
      .insert(settings)
      .values(row)
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: row.value, updatedAt: row.updatedAt },
      })
      .returning()

    return toRecord(stored ?? row)
  }

  async remove(key: string): Promise<boolean> {
    const removed = await this.handle
      .delete(settings)
      .where(eq(settings.key, key))
      .returning({ key: settings.key })
    return removed.length > 0
  }
}

function toRecord(row: { key: string; value: unknown; updatedAt: Date }): SettingRecord {
  // Drizzle returns the jsonb value already-parsed (numbers, objects, etc.,
  // not the raw text). Re-encode and decode through JSON so the read path
  // matches the write path: what the caller put in, they get back. A
  // non-string `row.value` (e.g. a pre-existing row from a different code
  // path) round-trips through `JSON.stringify` and comes out the same shape.
  const encoded = typeof row.value === 'string' ? row.value : JSON.stringify(row.value)
  return { key: row.key, value: JSON.parse(encoded) as unknown, updatedAt: row.updatedAt }
}

class PostgresOwnerRepository implements OwnerRepository {
  constructor(private readonly handle: Handle) {}

  async get(): Promise<OwnerRecord | null> {
    const [row] = await this.handle.select().from(owner).where(eq(owner.id, OWNER_ROW_ID)).limit(1)
    return row ? toOwner(row) : null
  }

  async create(created: {
    username: string
    passwordHash: string
    at: Date
  }): Promise<OwnerRecord | null> {
    const [row] = await this.handle
      .insert(owner)
      .values({
        id: OWNER_ROW_ID,
        username: created.username,
        passwordHash: created.passwordHash,
        createdAt: created.at,
        passwordChangedAt: created.at,
      })
      .onConflictDoNothing()
      .returning()

    return row ? toOwner(row) : null
  }

  async changePassword(passwordHash: string, at: Date): Promise<OwnerRecord | null> {
    const [row] = await this.handle
      .update(owner)
      .set({ passwordHash, passwordChangedAt: at })
      .where(eq(owner.id, OWNER_ROW_ID))
      .returning()

    return row ? toOwner(row) : null
  }
}

function toOwner(row: {
  username: string
  passwordHash: string
  createdAt: Date
  passwordChangedAt: Date
}): OwnerRecord {
  return {
    username: row.username,
    passwordHash: row.passwordHash,
    createdAt: row.createdAt,
    passwordChangedAt: row.passwordChangedAt,
  }
}

class PostgresSessionRepository implements SessionRepository {
  constructor(private readonly handle: Handle) {}

  async create(session: SessionRecord): Promise<SessionRecord> {
    const [row] = await this.handle.insert(ownerSessions).values(session).returning()
    return toSession(row ?? session)
  }

  async get(id: string): Promise<SessionRecord | null> {
    const [row] = await this.handle
      .select()
      .from(ownerSessions)
      .where(eq(ownerSessions.id, id))
      .limit(1)
    return row ? toSession(row) : null
  }

  async list(): Promise<readonly SessionRecord[]> {
    const rows = await this.handle
      .select()
      .from(ownerSessions)
      .orderBy(desc(ownerSessions.lastSeenAt), ownerSessions.id)
    return rows.map(toSession)
  }

  async touch(id: string, lastSeenAt: Date, expiresAt: Date): Promise<boolean> {
    const touched = await this.handle
      .update(ownerSessions)
      .set({ lastSeenAt, expiresAt })
      .where(eq(ownerSessions.id, id))
      .returning({ id: ownerSessions.id })
    return touched.length > 0
  }

  async remove(id: string): Promise<boolean> {
    const removed = await this.handle
      .delete(ownerSessions)
      .where(eq(ownerSessions.id, id))
      .returning({ id: ownerSessions.id })
    return removed.length > 0
  }

  async removeAll(): Promise<number> {
    const removed = await this.handle.delete(ownerSessions).returning({ id: ownerSessions.id })
    return removed.length
  }

  async removeExpired(now: Date): Promise<number> {
    const removed = await this.handle
      .delete(ownerSessions)
      .where(lt(ownerSessions.expiresAt, now))
      .returning({ id: ownerSessions.id })
    return removed.length
  }
}

function toSession(row: {
  id: string
  secretHash: string
  csrfToken: string
  createdAt: Date
  lastSeenAt: Date
  expiresAt: Date
  userAgent: string | null
}): SessionRecord {
  return {
    id: row.id,
    secretHash: row.secretHash,
    csrfToken: row.csrfToken,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    userAgent: row.userAgent,
  }
}

class PostgresAuditRepository implements AuditRepository {
  constructor(private readonly handle: Handle) {}

  async record(event: {
    action: string
    outcome: AuditOutcome
    detail?: unknown
    at: Date
  }): Promise<AuditEventRecord> {
    const [row] = await this.handle
      .insert(auditEvents)
      .values({
        occurredAt: event.at,
        action: event.action,
        outcome: event.outcome,
        detail: event.detail === undefined ? null : event.detail,
      })
      .returning()

    if (!row) throw new DatabaseUnavailableError('Recording an audit event returned no row')
    return toAuditEvent(row)
  }

  async list(options: { limit?: number } = {}): Promise<readonly AuditEventRecord[]> {
    const query = this.handle
      .select()
      .from(auditEvents)
      .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))

    const rows = options.limit === undefined ? await query : await query.limit(options.limit)
    return rows.map(toAuditEvent)
  }
}

function toAuditEvent(row: {
  id: number
  occurredAt: Date
  action: string
  outcome: string
  detail: unknown
}): AuditEventRecord {
  return {
    id: row.id,
    occurredAt: row.occurredAt,
    action: row.action,
    outcome: row.outcome as AuditOutcome,
    detail: row.detail ?? null,
  }
}

class PostgresProviderRepository implements ProviderRepository {
  constructor(private readonly handle: Handle) {}

  async listProviders(): Promise<readonly ProviderRecord[]> {
    const rows = await this.handle
      .select()
      .from(providers)
      .orderBy(desc(providers.createdAt), desc(providers.id))
    return rows.map(toProvider)
  }

  async getProvider(id: string): Promise<ProviderRecord | null> {
    const [row] = await this.handle
      .select()
      .from(providers)
      .where(eq(providers.id, id))
      .limit(1)
    return row ? toProvider(row) : null
  }

  async getProviderByHandle(providerHandle: string): Promise<ProviderRecord | null> {
    const [row] = await this.handle.select().from(providers).where(eq(providers.handle, providerHandle)).limit(1)
    return row ? toProvider(row) : null
  }

  async insertProvider(
    connection: ProviderRecord,
  ): Promise<ProviderRecord> {
    const encoded = encodeProviderRow(connection)
    const [row] = await this.handle.insert(providers).values(encoded).returning()
    return toProvider(row ?? encoded)
  }

  async updateProvider(
    id: string,
    patch: ProviderPatch,
    at: Date,
  ): Promise<ProviderRecord | null> {
    const changed = { ...encodeProviderPatch(patch), updatedAt: at }
    const [row] = await this.handle
      .update(providers)
      .set(changed)
      .where(eq(providers.id, id))
      .returning()
    return row ? toProvider(row) : null
  }

  async deleteProvider(id: string): Promise<boolean> {
    const removed = await this.handle
      .delete(providers)
      .where(eq(providers.id, id))
      .returning({ id: providers.id })
    return removed.length > 0
  }

  async listKeys(providerId: string): Promise<readonly UpstreamKeyRecord[]> {
    const rows = await this.handle
      .select()
      .from(upstreamKeys)
      .where(eq(upstreamKeys.providerId, providerId))
      .orderBy(upstreamKeys.createdAt, upstreamKeys.id)
    return rows.map(toKey)
  }

  async getKey(id: string): Promise<UpstreamKeyRecord | null> {
    const [row] = await this.handle
      .select()
      .from(upstreamKeys)
      .where(eq(upstreamKeys.id, id))
      .limit(1)
    return row ? toKey(row) : null
  }

  async insertKey(key: UpstreamKeyRecord): Promise<UpstreamKeyRecord> {
    // The jsonb model lists pass through unchanged; no encoding lives here.
    const [row] = await this.handle.insert(upstreamKeys).values(key).returning()
    return toKey(row ?? key)
  }

  async updateKey(
    id: string,
    patch: UpstreamKeyPatch,
    at: Date,
  ): Promise<UpstreamKeyRecord | null> {
    const changed = { ...patch, updatedAt: at }
    const [row] = await this.handle
      .update(upstreamKeys)
      .set(changed)
      .where(eq(upstreamKeys.id, id))
      .returning()
    return row ? toKey(row) : null
  }

  async deleteKey(id: string): Promise<boolean> {
    const removed = await this.handle
      .delete(upstreamKeys)
      .where(eq(upstreamKeys.id, id))
      .returning({ id: upstreamKeys.id })
    return removed.length > 0
  }

  async deleteKeysForProvider(providerId: string): Promise<number> {
    const removed = await this.handle
      .delete(upstreamKeys)
      .where(eq(upstreamKeys.providerId, providerId))
      .returning({ id: upstreamKeys.id })
    return removed.length
  }

  async listAccounts(providerId: string): Promise<readonly UpstreamAccountRecord[]> {
    const rows = await this.handle
      .select()
      .from(upstreamAccounts)
      .where(eq(upstreamAccounts.providerId, providerId))
      .orderBy(upstreamAccounts.createdAt, upstreamAccounts.id)
    return rows.map(toAccount)
  }

  async getAccount(id: string): Promise<UpstreamAccountRecord | null> {
    const [row] = await this.handle
      .select()
      .from(upstreamAccounts)
      .where(eq(upstreamAccounts.id, id))
      .limit(1)
    return row ? toAccount(row) : null
  }

  async insertAccount(account: UpstreamAccountRecord): Promise<UpstreamAccountRecord> {
    const [row] = await this.handle.insert(upstreamAccounts).values(account).returning()
    return toAccount(row ?? account)
  }

  async updateAccount(
    id: string,
    patch: UpstreamAccountPatch,
    at: Date,
  ): Promise<UpstreamAccountRecord | null> {
    const [row] = await this.handle
      .update(upstreamAccounts)
      .set({ ...patch, updatedAt: at })
      .where(eq(upstreamAccounts.id, id))
      .returning()
    return row ? toAccount(row) : null
  }

  async deleteAccount(id: string): Promise<boolean> {
    const removed = await this.handle
      .delete(upstreamAccounts)
      .where(eq(upstreamAccounts.id, id))
      .returning({ id: upstreamAccounts.id })
    return removed.length > 0
  }

  async providerDefaultBaseUrl(providerId: string, keyId: string): Promise<string | null> {
    const key = await this.getKey(keyId)
    if (key === null || key.providerId !== providerId) return null
    if (key.baseUrl !== null) return key.baseUrl
    const provider = await this.getProvider(providerId)
    return provider?.baseUrl ?? null
  }
}

type AccountRow = typeof upstreamAccounts.$inferSelect

function toAccount(row: AccountRow): UpstreamAccountRecord {
  return {
    id: row.id,
    providerId: row.providerId,
    displayName: row.displayName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

class PostgresGatewayKeyRepository implements GatewayKeyRepository {
  constructor(private readonly handle: Handle) {}

  async list(): Promise<readonly GatewayKeyRecord[]> {
    const rows = await this.handle
      .select()
      .from(gatewayKeys)
      .orderBy(desc(gatewayKeys.createdAt), desc(gatewayKeys.id))
    return rows.map(toGatewayKey)
  }

  async get(id: string): Promise<GatewayKeyRecord | null> {
    const [row] = await this.handle.select().from(gatewayKeys).where(eq(gatewayKeys.id, id)).limit(1)
    return row ? toGatewayKey(row) : null
  }

  async insert(key: GatewayKeyRecord): Promise<GatewayKeyRecord> {
    const encoded = encodeGatewayKeyRow(key)
    const [row] = await this.handle.insert(gatewayKeys).values(encoded).returning()
    return toGatewayKey(row ?? encoded)
  }

  async markUsed(id: string, at: Date): Promise<boolean> {
    const touched = await this.handle
      .update(gatewayKeys)
      .set({ lastUsedAt: at })
      .where(eq(gatewayKeys.id, id))
      .returning({ id: gatewayKeys.id })
    return touched.length > 0
  }

  async revoke(id: string, at: Date): Promise<GatewayKeyRecord | null> {
    const [row] = await this.handle
      .update(gatewayKeys)
      .set({ revokedAt: at })
      .where(eq(gatewayKeys.id, id))
      .returning()
    return row ? toGatewayKey(row) : null
  }

  async deleteRevoked(id: string): Promise<boolean> {
    const rows = await this.handle
      .delete(gatewayKeys)
      .where(and(eq(gatewayKeys.id, id), isNotNull(gatewayKeys.revokedAt)))
      .returning({ id: gatewayKeys.id })
    return rows.length > 0
  }

  async updateActive(
    id: string,
    expectedRevision: number,
    patch: { name: string; access: import('../repository.ts').GatewayKeyAccess; scope: readonly GatewayKeyScopeEntry[]; corsOrigins: readonly string[] },
    _at: Date,
  ): Promise<GatewayKeyRecord | null> {
    const [row] = await this.handle
      .update(gatewayKeys)
      .set({
        name: patch.name,
        accessMode: patch.access.mode,
        scope: [...patch.scope],
        corsOrigins: [...patch.corsOrigins],
        revision: expectedRevision + 1,
      })
      .where(and(eq(gatewayKeys.id, id), eq(gatewayKeys.revision, expectedRevision), isNull(gatewayKeys.revokedAt)))
      .returning()
    return row ? toGatewayKey(row) : null
  }

  async updateCorsOrigins(
    id: string,
    origins: readonly string[],
    _at: Date,
  ): Promise<GatewayKeyRecord | null> {
    const [row] = await this.handle
      .update(gatewayKeys)
      .set({ corsOrigins: [...origins] })
      .where(eq(gatewayKeys.id, id))
      .returning()
    return row ? toGatewayKey(row) : null
  }
}

type GatewayKeyRow = typeof gatewayKeys.$inferSelect

function toGatewayKey(row: GatewayKeyRow): GatewayKeyRecord {
  return {
    id: row.id,
    name: row.name,
    secretHash: row.secretHash,
    scope: row.scope as readonly GatewayKeyScopeEntry[],
    access: row.accessMode === 'all'
      ? { mode: 'all' }
      : { mode: 'selected', providers: row.scope as readonly GatewayKeyScopeEntry[] },
    revision: row.revision,
    corsOrigins: (row.corsOrigins ?? []) as readonly string[],
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  }
}

function encodeGatewayKeyRow(key: GatewayKeyRecord): {
  id: string
  name: string
  secretHash: string
  scope: readonly GatewayKeyScopeEntry[]
  accessMode: string
  revision: number
  corsOrigins: readonly string[]
  createdAt: Date
  lastUsedAt: Date | null
  revokedAt: Date | null
} {
  return {
    id: key.id,
    name: key.name,
    secretHash: key.secretHash,
    scope: key.scope,
    accessMode: key.access?.mode ?? 'selected',
    revision: key.revision ?? 1,
    corsOrigins: [...key.corsOrigins],
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    revokedAt: key.revokedAt,
  }
}

type ProviderRow = typeof providers.$inferSelect
type KeyRow = typeof upstreamKeys.$inferSelect

function toProvider(row: ProviderRow): ProviderRecord {
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.displayName,
    baseUrl: row.baseUrl,
    logoDomain: row.logoDomain,
    allowInsecureHttp: row.allowInsecureHttp,
    enabled: row.enabled,
    retryMaxAttempts: row.retryMaxAttempts,
    retryAmbiguousNetwork: row.retryAmbiguousNetwork,
    archivedAt: row.archivedAt,
    templateId: row.templateId,
    capabilities: parseCapabilities(row.capabilities),
    authHeader: row.authHeader,
    authPrefix: row.authPrefix,
    staticHeadersEncrypted: row.staticHeadersEncrypted,
    redirectAllowSameOrigin: row.redirectAllowSameOrigin,
    connectionTimeoutMs: row.connectionTimeoutMs,
    firstByteTimeoutMs: row.firstByteTimeoutMs,
    nonStreamingTotalTimeoutMs: row.nonStreamingTotalTimeoutMs,
    streamingIdleTimeoutMs: row.streamingIdleTimeoutMs,
    totalRetryTimeoutMs: row.totalRetryTimeoutMs,
    idempotencyHeader: row.idempotencyHeader,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/**
 * The row a caller hands the PostgreSQL repository carries the cipher output of
 * `staticHeadersEncrypted` and a JSON-encoded `capabilities` blob. The caller
 * (the registry) is responsible for encrypting the static headers before
 * `insertProvider` and for supplying `staticHeadersEncrypted` on the patch
 * passed to `updateProvider`.
 */
function encodeProviderRow(provider: ProviderRecord): {
  id: string
  handle: string
  displayName: string
  baseUrl: string
  logoDomain: string | null
  allowInsecureHttp: boolean
  enabled: boolean
  retryMaxAttempts: number
  retryAmbiguousNetwork: boolean
  archivedAt: Date | null
  templateId: string | null
  capabilities: string
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
} {
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
    archivedAt: provider.archivedAt,
    templateId: provider.templateId,
    capabilities: JSON.stringify(provider.capabilities),
    authHeader: provider.authHeader,
    authPrefix: provider.authPrefix,
    staticHeadersEncrypted: provider.staticHeadersEncrypted,
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

function encodeProviderPatch(patch: ProviderPatch): Partial<ReturnType<typeof encodeProviderRow>> {
  const encoded = { ...(patch as Record<string, unknown>) }
  if (patch.capabilities !== undefined) {
    encoded.capabilities = JSON.stringify(patch.capabilities)
  }
  return encoded as Partial<ReturnType<typeof encodeProviderRow>>
}

function toKey(row: KeyRow): UpstreamKeyRecord {
  return {
    id: row.id,
    providerId: row.providerId,
    baseUrl: row.baseUrl,
    accountId: row.accountId,
    encryptedKey: row.encryptedKey,
    health: row.health as UpstreamKeyHealth,
    lastProbeAt: row.lastProbeAt,
    lastProbeVerdict: row.lastProbeVerdict === 'usable'
      ? 'authenticated'
      : row.lastProbeVerdict as KeyProbeVerdict | null,
    lastProbeReason: row.lastProbeReason,
    healthReason: row.healthReason,
    healthChangedAt: row.healthChangedAt ?? row.updatedAt,
    retryAfterAt: row.retryAfterAt,
    healthScope: row.healthScope as UpstreamKeyRecord['healthScope'],
    healthScopeId: row.healthScopeId,
    healthModel: row.healthModel,
    allowedModels: row.allowedModels as readonly string[] | null,
    deniedModels: row.deniedModels as readonly string[] | null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

class PostgresModelCatalogRepository implements ModelCatalogRepository {
  constructor(private readonly handle: Handle) {}

  async listEntries(providerId: string): Promise<readonly ModelCatalogEntryRecord[]> {
    const rows = await this.handle
      .select()
      .from(modelCatalogEntries)
      .where(eq(modelCatalogEntries.providerId, providerId))
      .orderBy(modelCatalogEntries.createdAt, modelCatalogEntries.modelId)
    return rows.map(toModelEntry)
  }

  async syncDiscovered(providerId: string, modelIds: readonly string[], at: Date): Promise<void> {
    const desired = new Set(modelIds)

    for (const modelId of modelIds) {
      const [existing] = await this.handle
        .select({ id: modelCatalogEntries.modelId })
        .from(modelCatalogEntries)
        .where(
          and(
            eq(modelCatalogEntries.providerId, providerId),
            eq(modelCatalogEntries.modelId, modelId),
          ),
        )
        .limit(1)

      if (existing === undefined) {
        await this.handle.insert(modelCatalogEntries).values({
          providerId,
          modelId,
          source: 'discovered',
          excluded: false,
          overrides: null,
          createdAt: at,
          updatedAt: at,
        })
      } else {
        await this.handle
          .update(modelCatalogEntries)
          .set({ source: 'discovered', updatedAt: at })
          .where(
            and(
              eq(modelCatalogEntries.providerId, providerId),
              eq(modelCatalogEntries.modelId, modelId),
            ),
          )
      }
    }

    const rows = await this.handle
      .select({ modelId: modelCatalogEntries.modelId, excluded: modelCatalogEntries.excluded })
      .from(modelCatalogEntries)
      .where(eq(modelCatalogEntries.providerId, providerId))
    for (const row of rows) {
      if (!row.excluded && !desired.has(row.modelId)) {
        await this.handle
          .delete(modelCatalogEntries)
          .where(
            and(
              eq(modelCatalogEntries.providerId, providerId),
              eq(modelCatalogEntries.modelId, row.modelId),
              eq(modelCatalogEntries.source, 'discovered'),
            ),
          )
      }
    }
  }

  async syncTemplate(providerId: string, modelIds: readonly string[], at: Date): Promise<void> {
    for (const modelId of modelIds) {
      const [existing] = await this.handle
        .select({ id: modelCatalogEntries.modelId })
        .from(modelCatalogEntries)
        .where(
          and(
            eq(modelCatalogEntries.providerId, providerId),
            eq(modelCatalogEntries.modelId, modelId),
          ),
        )
        .limit(1)
      if (existing !== undefined) continue

      await this.handle.insert(modelCatalogEntries).values({
        providerId,
        modelId,
        source: 'template',
        excluded: false,
        overrides: null,
        createdAt: at,
        updatedAt: at,
      })
    }
  }

  async addOwnerModel(providerId: string, modelId: string, at: Date): Promise<void> {
    const [existing] = await this.handle
      .select({ source: modelCatalogEntries.source })
      .from(modelCatalogEntries)
      .where(
        and(
          eq(modelCatalogEntries.providerId, providerId),
          eq(modelCatalogEntries.modelId, modelId),
        ),
      )
      .limit(1)

    if (existing === undefined) {
      await this.handle.insert(modelCatalogEntries).values({
        providerId,
        modelId,
        source: 'owner_added',
        excluded: false,
        overrides: null,
        createdAt: at,
        updatedAt: at,
      })
      return
    }

    if (existing.source === 'excluded') {
      await this.handle
        .update(modelCatalogEntries)
        .set({ source: 'owner_added', excluded: false, updatedAt: at })
        .where(
          and(
            eq(modelCatalogEntries.providerId, providerId),
            eq(modelCatalogEntries.modelId, modelId),
          ),
        )
    }
  }

  async removeOwnerModel(providerId: string, modelId: string): Promise<boolean> {
    const removed = await this.handle
      .delete(modelCatalogEntries)
      .where(
        and(
          eq(modelCatalogEntries.providerId, providerId),
          eq(modelCatalogEntries.modelId, modelId),
          eq(modelCatalogEntries.source, 'owner_added'),
        ),
      )
      .returning({ id: modelCatalogEntries.modelId })
    return removed.length > 0
  }

  async setExcluded(providerId: string, modelId: string, excluded: boolean, at: Date): Promise<void> {
    const [existing] = await this.handle
      .select({ source: modelCatalogEntries.source })
      .from(modelCatalogEntries)
      .where(
        and(
          eq(modelCatalogEntries.providerId, providerId),
          eq(modelCatalogEntries.modelId, modelId),
        ),
      )
      .limit(1)

    if (excluded) {
      if (existing === undefined) {
        await this.handle.insert(modelCatalogEntries).values({
          providerId,
          modelId,
          source: 'excluded',
          excluded: true,
          overrides: null,
          createdAt: at,
          updatedAt: at,
        })
      } else {
        await this.handle
          .update(modelCatalogEntries)
          .set({ excluded: true, updatedAt: at })
          .where(
            and(
              eq(modelCatalogEntries.providerId, providerId),
              eq(modelCatalogEntries.modelId, modelId),
            ),
          )
      }
      return
    }

    if (existing === undefined) return

    if (existing.source === 'excluded') {
      await this.handle
        .delete(modelCatalogEntries)
        .where(
          and(
            eq(modelCatalogEntries.providerId, providerId),
            eq(modelCatalogEntries.modelId, modelId),
          ),
        )
    } else {
      await this.handle
        .update(modelCatalogEntries)
        .set({ excluded: false, updatedAt: at })
        .where(
          and(
            eq(modelCatalogEntries.providerId, providerId),
            eq(modelCatalogEntries.modelId, modelId),
          ),
        )
    }
  }

  async updateOverrides(
    providerId: string,
    modelId: string,
    overrides: Readonly<Partial<ProviderCapabilities>>,
    at: Date,
  ): Promise<void> {
    const [existing] = await this.handle
      .select({ id: modelCatalogEntries.modelId })
      .from(modelCatalogEntries)
      .where(
        and(
          eq(modelCatalogEntries.providerId, providerId),
          eq(modelCatalogEntries.modelId, modelId),
        ),
      )
      .limit(1)

    if (existing === undefined) {
      await this.handle.insert(modelCatalogEntries).values({
        providerId,
        modelId,
        source: 'owner_added',
        excluded: false,
        overrides,
        createdAt: at,
        updatedAt: at,
      })
    } else {
      await this.handle
        .update(modelCatalogEntries)
        .set({ overrides, updatedAt: at })
        .where(
          and(
            eq(modelCatalogEntries.providerId, providerId),
            eq(modelCatalogEntries.modelId, modelId),
          ),
        )
    }
  }

  async isExcluded(providerId: string, modelId: string): Promise<boolean> {
    const [row] = await this.handle
      .select({ excluded: modelCatalogEntries.excluded })
      .from(modelCatalogEntries)
      .where(
        and(
          eq(modelCatalogEntries.providerId, providerId),
          eq(modelCatalogEntries.modelId, modelId),
        ),
      )
      .limit(1)
    return row?.excluded === true
  }

  async getSync(providerId: string): Promise<ModelCatalogSyncRecord | null> {
    const [row] = await this.handle
      .select()
      .from(modelCatalogSync)
      .where(eq(modelCatalogSync.providerId, providerId))
      .limit(1)
    return row ? toSyncRecord(row) : null
  }

  async putSync(record: ModelCatalogSyncRecord): Promise<void> {
    await this.handle
      .insert(modelCatalogSync)
      .values(record)
      .onConflictDoUpdate({
        target: modelCatalogSync.providerId,
        set: {
          syncedAt: record.syncedAt,
          lastSuccessAt: record.lastSuccessAt,
          lastFailureAt: record.lastFailureAt,
          lastFailureMessage: record.lastFailureMessage,
        },
      })
  }
}

type ModelEntryRow = typeof modelCatalogEntries.$inferSelect
type SyncRow = typeof modelCatalogSync.$inferSelect

function toModelEntry(row: ModelEntryRow): ModelCatalogEntryRecord {
  return {
    providerId: row.providerId,
    modelId: row.modelId,
    source: row.source as ModelCatalogSource,
    excluded: row.excluded,
    overrides: row.overrides as Readonly<Partial<ProviderCapabilities>> | null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function toSyncRecord(row: SyncRow): ModelCatalogSyncRecord {
  return {
    providerId: row.providerId,
    syncedAt: row.syncedAt,
    lastSuccessAt: row.lastSuccessAt,
    lastFailureAt: row.lastFailureAt,
    lastFailureMessage: row.lastFailureMessage,
  }
}

class PostgresUsageRepository implements UsageRepository {
  constructor(private readonly handle: Handle) {}

  async get(providerId: string): Promise<UsageSnapshotRecord | null> {
    const [row] = await this.handle
      .select()
      .from(usageSnapshots)
      .where(eq(usageSnapshots.providerId, providerId))
      .limit(1)
    return row ? toUsageSnapshot(row) : null
  }

  async put(record: UsageSnapshotRecord): Promise<void> {
    await this.handle
      .insert(usageSnapshots)
      .values({
        providerId: record.providerId,
        visibility: record.visibility,
        syncedAt: record.syncedAt,
        lastSuccessAt: record.lastSuccessAt,
        lastFailureAt: record.lastFailureAt,
        lastFailureCode: record.lastFailureCode,
        lastFailureMessage: record.lastFailureMessage,
        result: record.result === null ? null : record.result,
      })
      .onConflictDoUpdate({
        target: usageSnapshots.providerId,
        set: {
          visibility: record.visibility,
          syncedAt: record.syncedAt,
          lastSuccessAt: record.lastSuccessAt,
          lastFailureAt: record.lastFailureAt,
          lastFailureCode: record.lastFailureCode,
          lastFailureMessage: record.lastFailureMessage,
          result: record.result === null ? null : record.result,
        },
      })
  }
}

type UsageSnapshotRow = typeof usageSnapshots.$inferSelect

function toUsageSnapshot(row: UsageSnapshotRow): UsageSnapshotRecord {
  return {
    providerId: row.providerId,
    visibility: row.visibility === 'authoritative' ? 'authoritative' : 'reactive_only',
    syncedAt: row.syncedAt,
    lastSuccessAt: row.lastSuccessAt,
    lastFailureAt: row.lastFailureAt,
    lastFailureCode: row.lastFailureCode,
    lastFailureMessage: row.lastFailureMessage,
    result: row.result === null ? null : row.result,
  }
}

/** jsonb -> capabilities. A corrupted row must not silently become defaults. */
function parseCapabilities(value: unknown): ProviderCapabilities {
  const parsed = (typeof value === 'object' && value !== null
    ? value
    : {}) as Partial<ProviderCapabilities>
  return {
    chat: parsed.chat === true,
    streaming: parsed.streaming === true,
    tools: parsed.tools === true,
    structuredOutput: parsed.structuredOutput === true,
    responses: parsed.responses === true,
  }
}

class PostgresRequestHistoryRepository implements RequestHistoryRepository {
  constructor(private readonly handle: Handle) {}

  async recordEvent(event: RequestEventRecord): Promise<void> {
    // The request-history service writes the event row lazily in
    // `startAttempt` (with status=0, outcome='failure' defaults) and then
    // overwrites it in `finalize` (with the real status and outcome). A
    // pure `INSERT ... ON CONFLICT DO UPDATE` upsert does not behave the
    // same on every engine — the rewrite below is an UPDATE-by-id first,
    // falling back to INSERT when the row was never written (the
    // `recordSkip` path runs without a prior `startAttempt`). The attempt
    // row already uses this UPDATE-by-id shape (`updateAttempt`) and
    // works correctly across both engines.
    const updated = await this.handle
      .update(requestEvents)
      .set({
        lifecycle: event.lifecycle ?? 'completed',
        occurredAt: event.occurredAt,
        providerId: event.providerId,
        providerHandle: event.providerHandle ?? null,
        model: event.model,
        gatewayKeyId: event.gatewayKeyId,
        gatewayKeyName: event.gatewayKeyName,
        keyId: event.keyId,
        status: event.status,
        outcome: event.outcome,
        latencyMs: event.latencyMs,
        isStreaming: event.isStreaming,
        promptTokens: event.promptTokens,
        completionTokens: event.completionTokens,
        totalTokens: event.totalTokens,
        errorCode: event.errorCode,
      })
      .where(eq(requestEvents.id, event.id))
      .returning({ id: requestEvents.id })

    if (updated.length > 0) return

    await this.handle
      .insert(requestEvents)
      .values({
        id: event.id,
        lifecycle: event.lifecycle ?? 'completed',
        occurredAt: event.occurredAt,
        providerId: event.providerId,
        providerHandle: event.providerHandle ?? null,
        model: event.model,
        gatewayKeyId: event.gatewayKeyId,
        gatewayKeyName: event.gatewayKeyName,
        keyId: event.keyId,
        status: event.status,
        outcome: event.outcome,
        latencyMs: event.latencyMs,
        isStreaming: event.isStreaming,
        promptTokens: event.promptTokens,
        completionTokens: event.completionTokens,
        totalTokens: event.totalTokens,
        errorCode: event.errorCode,
      })
  }

  async recordAttempt(attempt: RequestAttemptInput): Promise<RequestAttemptRecord> {
    const [row] = await this.handle
      .insert(requestAttempts)
      .values({
        requestId: attempt.requestId,
        attemptNumber: attempt.attemptNumber,
        keyId: attempt.keyId,
        startedAt: attempt.startedAt,
        completedAt: attempt.completedAt,
        status: attempt.status,
        outcome: attempt.outcome,
        errorCode: attempt.errorCode,
        retryAfterSeconds: attempt.retryAfterSeconds,
        diagnostics: providerDiagnosticsOf(attempt.diagnostics),
      })
      .returning()

    if (!row) throw new DatabaseUnavailableError('Recording a request attempt returned no row')
    return toAttempt(row)
  }

  async updateAttempt(
    id: number,
    patch: {
      readonly completedAt: Date
      readonly status: number | null
      readonly outcome: AttemptOutcome
      readonly errorCode: string | null
      readonly retryAfterSeconds: number | null
      readonly diagnostics?: unknown
    },
  ): Promise<void> {
    await this.handle
      .update(requestAttempts)
      .set({
        completedAt: patch.completedAt,
        status: patch.status,
        outcome: patch.outcome,
        errorCode: patch.errorCode,
        retryAfterSeconds: patch.retryAfterSeconds,
        ...(patch.diagnostics === undefined
          ? {}
          : { diagnostics: providerDiagnosticsOf(patch.diagnostics) }),
      })
      .where(eq(requestAttempts.id, id))
  }

  async getEvent(id: string): Promise<RequestEventRecord | null> {
    const [row] = await this.handle
      .select()
      .from(requestEvents)
      .where(and(eq(requestEvents.id, id), eq(requestEvents.lifecycle, 'completed'), ne(requestEvents.status, 0)))
      .limit(1)
    return row ? toEvent(row) : null
  }

  async getAttempts(requestId: string): Promise<readonly RequestAttemptRecord[]> {
    const rows = await this.handle
      .select()
      .from(requestAttempts)
      .where(eq(requestAttempts.requestId, requestId))
      .orderBy(asc(requestAttempts.attemptNumber), asc(requestAttempts.id))
    return rows.map(toAttempt)
  }

  async listEvents(
    options: RequestHistoryListOptions = {},
  ): Promise<RequestHistoryListResult> {
    const filter = options.filter ?? {}
    const where = eventFilter(filter)

    const totalRow = await this.handle.select({ value: count() }).from(requestEvents).where(where)
    const total = totalRow[0]?.value ?? 0

    const query = this.handle
      .select()
      .from(requestEvents)
      .where(where)
      .orderBy(desc(requestEvents.occurredAt), desc(requestEvents.id))

    const limited =
      options.limit === undefined
        ? await query
        : options.offset === undefined
          ? await query.limit(options.limit)
          : await query.limit(options.limit).offset(options.offset)

    return { events: limited.map(toEvent), total }
  }

  async abandonRequests(before: Date): Promise<number> {
    const rows = await this.handle
      .update(requestEvents)
      .set({ lifecycle: 'abandoned' })
      .where(and(eq(requestEvents.lifecycle, 'in_progress'), lt(requestEvents.occurredAt, before)))
      .returning({ id: requestEvents.id })
    return rows.length
  }

  async pruneEvents(before: Date): Promise<number> {
    const removed = await this.handle
      .delete(requestEvents)
      .where(lt(requestEvents.occurredAt, before))
      .returning({ id: requestEvents.id })
    return removed.length
  }

  async pruneEventsBounded(before: Date, limit: number): Promise<number> {
    if (limit <= 0) return 0
    // PostgreSQL has no `DELETE LIMIT`; an IN subquery selects the oldest
    // `limit` ids and the cascade deletes only that batch.
    const removed = await this.handle
      .delete(requestEvents)
      .where(
        inArray(
          requestEvents.id,
          this.handle
            .select({ id: requestEvents.id })
            .from(requestEvents)
            .where(lt(requestEvents.occurredAt, before))
            .orderBy(asc(requestEvents.occurredAt), asc(requestEvents.id))
            .limit(limit),
        ),
      )
      .returning({ id: requestEvents.id })
    return removed.length
  }

  async listAudit(options: AuditListOptions = {}): Promise<AuditListResult> {
    const filter = options.filter ?? {}
    const where = auditFilter(filter)

    const totalRow = await this.handle.select({ value: count() }).from(auditEvents).where(where)
    const total = totalRow[0]?.value ?? 0

    const query = this.handle
      .select()
      .from(auditEvents)
      .where(where)
      .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))

    const limited =
      options.limit === undefined
        ? await query
        : options.offset === undefined
          ? await query.limit(options.limit)
          : await query.limit(options.limit).offset(options.offset)

    return { events: limited.map(toAuditEvent), total }
  }

  async clearAudit(): Promise<number> {
    const removed = await this.handle.delete(auditEvents).returning({ id: auditEvents.id })
    return removed.length
  }
}

type RequestEventRow = typeof requestEvents.$inferSelect
type RequestAttemptRow = typeof requestAttempts.$inferSelect

function toEvent(row: RequestEventRow): RequestEventRecord {
  return {
    id: row.id,
    lifecycle: row.lifecycle as 'in_progress' | 'completed' | 'abandoned',
    occurredAt: row.occurredAt,
    providerId: row.providerId,
    providerHandle: row.providerHandle,
    model: row.model,
    gatewayKeyId: row.gatewayKeyId,
    ...(row.gatewayKeyName === null ? {} : { gatewayKeyName: row.gatewayKeyName }),
    keyId: row.keyId,
    status: row.status,
    outcome: row.outcome as RequestOutcome,
    latencyMs: row.latencyMs,
    isStreaming: row.isStreaming,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    totalTokens: row.totalTokens,
    errorCode: row.errorCode,
  }
}

function toAttempt(row: RequestAttemptRow): RequestAttemptRecord {
  return {
    id: row.id,
    requestId: row.requestId,
    attemptNumber: row.attemptNumber,
    keyId: row.keyId,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    status: row.status,
    outcome: row.outcome as AttemptOutcome,
    errorCode: row.errorCode,
    retryAfterSeconds: row.retryAfterSeconds,
    diagnostics: providerDiagnosticsOf(row.diagnostics),
  }
}

function eventFilter(filter: RequestHistoryFilter) {
  const conditions = [eq(requestEvents.lifecycle, 'completed'), ne(requestEvents.status, 0)]
  if (filter.providerId !== undefined) {
    conditions.push(eq(requestEvents.providerId, filter.providerId))
  }
  if (filter.outcome !== undefined) {
    conditions.push(eq(requestEvents.outcome, filter.outcome))
  }
  if (filter.model !== undefined) {
    conditions.push(eq(requestEvents.model, filter.model))
  }
  if (filter.keyId !== undefined) {
    conditions.push(eq(requestEvents.keyId, filter.keyId))
  }
  if (filter.after !== undefined) {
    conditions.push(gte(requestEvents.occurredAt, filter.after))
  }
  if (filter.before !== undefined) {
    conditions.push(lt(requestEvents.occurredAt, filter.before))
  }
  return and(...conditions)
}

function auditFilter(filter: AuditFilter) {
  const conditions = []
  if (filter.actionPrefix !== undefined) {
    conditions.push(ilike(auditEvents.action, `${filter.actionPrefix}%`))
  }
  if (filter.outcome !== undefined) {
    conditions.push(eq(auditEvents.outcome, filter.outcome))
  }
  if (filter.after !== undefined) {
    conditions.push(gte(auditEvents.occurredAt, filter.after))
  }
  if (filter.before !== undefined) {
    conditions.push(lte(auditEvents.occurredAt, filter.before))
  }
  return conditions.length === 0 ? undefined : and(...conditions)
}

class PostgresBackgroundJobRepository implements BackgroundJobRepository {
  constructor(private readonly handle: Handle) {}

  async resetRunning(): Promise<number> {
    // A running row from a previous process is stale: the process no longer
    // owns the claim, so the row is moved back to idle. The WHERE clause is
    // the only way to tell an old "running" from a new one; the row keeps
    // its lastStartedAt/lastCompletedAt so the Owner can still see the run.
    const updated = await this.handle
      .update(backgroundJobs)
      .set({ status: 'idle', updatedAt: new Date() })
      .where(eq(backgroundJobs.status, 'running'))
      .returning({ jobId: backgroundJobs.jobId })
    return updated.length
  }

  async ensureIdle(jobId: string, at: Date): Promise<BackgroundJobRecord> {
    const [row] = await this.handle
      .insert(backgroundJobs)
      .values({
        jobId,
        status: 'idle',
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: backgroundJobs.jobId,
        set: { updatedAt: at },
      })
      .returning()
    if (row === undefined) throw new DatabaseUnavailableError('ensureIdle did not return a row')
    return toBackgroundJob(row)
  }

  async get(jobId: string): Promise<BackgroundJobRecord | null> {
    const [row] = await this.handle
      .select()
      .from(backgroundJobs)
      .where(eq(backgroundJobs.jobId, jobId))
      .limit(1)
    return row ? toBackgroundJob(row) : null
  }

  async list(): Promise<readonly BackgroundJobRecord[]> {
    const rows = await this.handle
      .select()
      .from(backgroundJobs)
      .orderBy(backgroundJobs.jobId)
    return rows.map(toBackgroundJob)
  }

  async tryClaim(jobId: string, startedAt: Date): Promise<Date | null> {
    // The UPDATE only matches when the existing row is not already running, so
    // two concurrent callers compete atomically and exactly one wins.
    const updated = await this.handle
      .update(backgroundJobs)
      .set({
        status: 'running',
        lastStartedAt: startedAt,
        lastCompletedAt: null,
        lastOutcome: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        lastDurationMs: null,
        lastAffectedCount: null,
        updatedAt: startedAt,
      })
      .where(and(eq(backgroundJobs.jobId, jobId), ne(backgroundJobs.status, 'running')))
      .returning({ startedAt: backgroundJobs.lastStartedAt })

    if (updated.length === 0) return null
    return updated[0]?.startedAt ?? null
  }

  async recordCompletion(
    jobId: string,
    completion: BackgroundJobCompletion,
  ): Promise<BackgroundJobRecord> {
    const [row] = await this.handle
      .update(backgroundJobs)
      .set({
        status: completion.status,
        lastCompletedAt: completion.completedAt,
        lastOutcome: completion.outcome,
        lastErrorCode: completion.errorCode ?? null,
        lastErrorMessage: completion.errorMessage ?? null,
        lastDurationMs: completion.durationMs,
        lastAffectedCount: completion.affectedCount ?? null,
        updatedAt: completion.completedAt,
      })
      .where(eq(backgroundJobs.jobId, jobId))
      .returning()

    if (row === undefined) {
      throw new DatabaseUnavailableError(
        `Background job ${jobId} has no row to update; tryClaim must have been called first`,
      )
    }
    return toBackgroundJob(row)
  }
}

type BackgroundJobRow = typeof backgroundJobs.$inferSelect

function toBackgroundJob(row: BackgroundJobRow): BackgroundJobRecord {
  return {
    jobId: row.jobId,
    lastStartedAt: row.lastStartedAt,
    lastCompletedAt: row.lastCompletedAt,
    status: row.status as BackgroundJobStatus,
    lastOutcome: row.lastOutcome as 'success' | 'failure' | null,
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    lastDurationMs: row.lastDurationMs,
    lastAffectedCount: row.lastAffectedCount,
    updatedAt: row.updatedAt,
  }
}
