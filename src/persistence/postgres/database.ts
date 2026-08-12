import { join } from 'node:path'
import { and, asc, count, desc, eq, gte, ilike, lt, lte, sql } from 'drizzle-orm'
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
  type ConnectionCapabilities,
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
  type ProviderConnectionPatch,
  type ProviderConnectionRecord,
  type ProviderRepository,
  type Repositories,
  type RequestAttemptRecord,
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
import {
  auditEvents,
  gatewayKeys,
  modelCatalogEntries,
  modelCatalogSync,
  owner,
  ownerSessions,
  providerConnections,
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
    const row = { key, value: value ?? null, updatedAt: new Date() }

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
  return { key: row.key, value: row.value, updatedAt: row.updatedAt }
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

  async listConnections(): Promise<readonly ProviderConnectionRecord[]> {
    const rows = await this.handle
      .select()
      .from(providerConnections)
      .orderBy(desc(providerConnections.createdAt), desc(providerConnections.id))
    return rows.map(toConnection)
  }

  async getConnection(id: string): Promise<ProviderConnectionRecord | null> {
    const [row] = await this.handle
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.id, id))
      .limit(1)
    return row ? toConnection(row) : null
  }

  async insertConnection(
    connection: ProviderConnectionRecord,
  ): Promise<ProviderConnectionRecord> {
    const encoded = encodeConnectionRow(connection)
    const [row] = await this.handle.insert(providerConnections).values(encoded).returning()
    return toConnection(row ?? encoded)
  }

  async updateConnection(
    id: string,
    patch: ProviderConnectionPatch,
    at: Date,
  ): Promise<ProviderConnectionRecord | null> {
    const changed = { ...encodeConnectionPatch(patch), updatedAt: at }
    const [row] = await this.handle
      .update(providerConnections)
      .set(changed)
      .where(eq(providerConnections.id, id))
      .returning()
    return row ? toConnection(row) : null
  }

  async deleteConnection(id: string): Promise<boolean> {
    const removed = await this.handle
      .delete(providerConnections)
      .where(eq(providerConnections.id, id))
      .returning({ id: providerConnections.id })
    return removed.length > 0
  }

  async listKeys(connectionId: string): Promise<readonly UpstreamKeyRecord[]> {
    const rows = await this.handle
      .select()
      .from(upstreamKeys)
      .where(eq(upstreamKeys.connectionId, connectionId))
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

  async deleteKeysForConnection(connectionId: string): Promise<number> {
    const removed = await this.handle
      .delete(upstreamKeys)
      .where(eq(upstreamKeys.connectionId, connectionId))
      .returning({ id: upstreamKeys.id })
    return removed.length
  }

  async listAccounts(connectionId: string): Promise<readonly UpstreamAccountRecord[]> {
    const rows = await this.handle
      .select()
      .from(upstreamAccounts)
      .where(eq(upstreamAccounts.connectionId, connectionId))
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
}

type AccountRow = typeof upstreamAccounts.$inferSelect

function toAccount(row: AccountRow): UpstreamAccountRecord {
  return {
    id: row.id,
    connectionId: row.connectionId,
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
    corsOrigins: [...key.corsOrigins],
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    revokedAt: key.revokedAt,
  }
}

type ConnectionRow = typeof providerConnections.$inferSelect
type KeyRow = typeof upstreamKeys.$inferSelect

function toConnection(row: ConnectionRow): ProviderConnectionRecord {
  return {
    id: row.id,
    displayName: row.displayName,
    baseUrl: row.baseUrl,
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
 * `insertConnection` and for supplying `staticHeadersEncrypted` on the patch
 * passed to `updateConnection`.
 */
function encodeConnectionRow(connection: ProviderConnectionRecord): {
  id: string
  displayName: string
  baseUrl: string
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
    id: connection.id,
    displayName: connection.displayName,
    baseUrl: connection.baseUrl,
    allowInsecureHttp: connection.allowInsecureHttp,
    enabled: connection.enabled,
    retryMaxAttempts: connection.retryMaxAttempts,
    retryAmbiguousNetwork: connection.retryAmbiguousNetwork,
    archivedAt: connection.archivedAt,
    templateId: connection.templateId,
    capabilities: JSON.stringify(connection.capabilities),
    authHeader: connection.authHeader,
    authPrefix: connection.authPrefix,
    staticHeadersEncrypted: connection.staticHeadersEncrypted,
    redirectAllowSameOrigin: connection.redirectAllowSameOrigin,
    connectionTimeoutMs: connection.connectionTimeoutMs,
    firstByteTimeoutMs: connection.firstByteTimeoutMs,
    nonStreamingTotalTimeoutMs: connection.nonStreamingTotalTimeoutMs,
    streamingIdleTimeoutMs: connection.streamingIdleTimeoutMs,
    totalRetryTimeoutMs: connection.totalRetryTimeoutMs,
    idempotencyHeader: connection.idempotencyHeader,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  }
}

function encodeConnectionPatch(patch: ProviderConnectionPatch): Partial<ReturnType<typeof encodeConnectionRow>> {
  const encoded = { ...(patch as Record<string, unknown>) }
  if (patch.capabilities !== undefined) {
    encoded.capabilities = JSON.stringify(patch.capabilities)
  }
  return encoded as Partial<ReturnType<typeof encodeConnectionRow>>
}

function toKey(row: KeyRow): UpstreamKeyRecord {
  return {
    id: row.id,
    connectionId: row.connectionId,
    accountId: row.accountId,
    encryptedKey: row.encryptedKey,
    health: row.health as UpstreamKeyHealth,
    lastProbeAt: row.lastProbeAt,
    lastProbeVerdict: row.lastProbeVerdict as KeyProbeVerdict | null,
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

  async listEntries(connectionId: string): Promise<readonly ModelCatalogEntryRecord[]> {
    const rows = await this.handle
      .select()
      .from(modelCatalogEntries)
      .where(eq(modelCatalogEntries.connectionId, connectionId))
      .orderBy(modelCatalogEntries.createdAt, modelCatalogEntries.modelId)
    return rows.map(toModelEntry)
  }

  async syncDiscovered(connectionId: string, modelIds: readonly string[], at: Date): Promise<void> {
    const desired = new Set(modelIds)

    for (const modelId of modelIds) {
      const [existing] = await this.handle
        .select({ id: modelCatalogEntries.modelId })
        .from(modelCatalogEntries)
        .where(
          and(
            eq(modelCatalogEntries.connectionId, connectionId),
            eq(modelCatalogEntries.modelId, modelId),
          ),
        )
        .limit(1)

      if (existing === undefined) {
        await this.handle.insert(modelCatalogEntries).values({
          connectionId,
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
              eq(modelCatalogEntries.connectionId, connectionId),
              eq(modelCatalogEntries.modelId, modelId),
            ),
          )
      }
    }

    const rows = await this.handle
      .select({ modelId: modelCatalogEntries.modelId, excluded: modelCatalogEntries.excluded })
      .from(modelCatalogEntries)
      .where(eq(modelCatalogEntries.connectionId, connectionId))
    for (const row of rows) {
      if (!row.excluded && !desired.has(row.modelId)) {
        await this.handle
          .delete(modelCatalogEntries)
          .where(
            and(
              eq(modelCatalogEntries.connectionId, connectionId),
              eq(modelCatalogEntries.modelId, row.modelId),
              eq(modelCatalogEntries.source, 'discovered'),
            ),
          )
      }
    }
  }

  async syncTemplate(connectionId: string, modelIds: readonly string[], at: Date): Promise<void> {
    for (const modelId of modelIds) {
      const [existing] = await this.handle
        .select({ id: modelCatalogEntries.modelId })
        .from(modelCatalogEntries)
        .where(
          and(
            eq(modelCatalogEntries.connectionId, connectionId),
            eq(modelCatalogEntries.modelId, modelId),
          ),
        )
        .limit(1)
      if (existing !== undefined) continue

      await this.handle.insert(modelCatalogEntries).values({
        connectionId,
        modelId,
        source: 'template',
        excluded: false,
        overrides: null,
        createdAt: at,
        updatedAt: at,
      })
    }
  }

  async addOwnerModel(connectionId: string, modelId: string, at: Date): Promise<void> {
    const [existing] = await this.handle
      .select({ source: modelCatalogEntries.source })
      .from(modelCatalogEntries)
      .where(
        and(
          eq(modelCatalogEntries.connectionId, connectionId),
          eq(modelCatalogEntries.modelId, modelId),
        ),
      )
      .limit(1)

    if (existing === undefined) {
      await this.handle.insert(modelCatalogEntries).values({
        connectionId,
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
            eq(modelCatalogEntries.connectionId, connectionId),
            eq(modelCatalogEntries.modelId, modelId),
          ),
        )
    }
  }

  async removeOwnerModel(connectionId: string, modelId: string): Promise<boolean> {
    const removed = await this.handle
      .delete(modelCatalogEntries)
      .where(
        and(
          eq(modelCatalogEntries.connectionId, connectionId),
          eq(modelCatalogEntries.modelId, modelId),
          eq(modelCatalogEntries.source, 'owner_added'),
        ),
      )
      .returning({ id: modelCatalogEntries.modelId })
    return removed.length > 0
  }

  async setExcluded(connectionId: string, modelId: string, excluded: boolean, at: Date): Promise<void> {
    const [existing] = await this.handle
      .select({ source: modelCatalogEntries.source })
      .from(modelCatalogEntries)
      .where(
        and(
          eq(modelCatalogEntries.connectionId, connectionId),
          eq(modelCatalogEntries.modelId, modelId),
        ),
      )
      .limit(1)

    if (excluded) {
      if (existing === undefined) {
        await this.handle.insert(modelCatalogEntries).values({
          connectionId,
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
              eq(modelCatalogEntries.connectionId, connectionId),
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
            eq(modelCatalogEntries.connectionId, connectionId),
            eq(modelCatalogEntries.modelId, modelId),
          ),
        )
    } else {
      await this.handle
        .update(modelCatalogEntries)
        .set({ excluded: false, updatedAt: at })
        .where(
          and(
            eq(modelCatalogEntries.connectionId, connectionId),
            eq(modelCatalogEntries.modelId, modelId),
          ),
        )
    }
  }

  async updateOverrides(
    connectionId: string,
    modelId: string,
    overrides: Readonly<Partial<ConnectionCapabilities>>,
    at: Date,
  ): Promise<void> {
    const [existing] = await this.handle
      .select({ id: modelCatalogEntries.modelId })
      .from(modelCatalogEntries)
      .where(
        and(
          eq(modelCatalogEntries.connectionId, connectionId),
          eq(modelCatalogEntries.modelId, modelId),
        ),
      )
      .limit(1)

    if (existing === undefined) {
      await this.handle.insert(modelCatalogEntries).values({
        connectionId,
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
            eq(modelCatalogEntries.connectionId, connectionId),
            eq(modelCatalogEntries.modelId, modelId),
          ),
        )
    }
  }

  async isExcluded(connectionId: string, modelId: string): Promise<boolean> {
    const [row] = await this.handle
      .select({ excluded: modelCatalogEntries.excluded })
      .from(modelCatalogEntries)
      .where(
        and(
          eq(modelCatalogEntries.connectionId, connectionId),
          eq(modelCatalogEntries.modelId, modelId),
        ),
      )
      .limit(1)
    return row?.excluded === true
  }

  async getSync(connectionId: string): Promise<ModelCatalogSyncRecord | null> {
    const [row] = await this.handle
      .select()
      .from(modelCatalogSync)
      .where(eq(modelCatalogSync.connectionId, connectionId))
      .limit(1)
    return row ? toSyncRecord(row) : null
  }

  async putSync(record: ModelCatalogSyncRecord): Promise<void> {
    await this.handle
      .insert(modelCatalogSync)
      .values(record)
      .onConflictDoUpdate({
        target: modelCatalogSync.connectionId,
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
    connectionId: row.connectionId,
    modelId: row.modelId,
    source: row.source as ModelCatalogSource,
    excluded: row.excluded,
    overrides: row.overrides as Readonly<Partial<ConnectionCapabilities>> | null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function toSyncRecord(row: SyncRow): ModelCatalogSyncRecord {
  return {
    connectionId: row.connectionId,
    syncedAt: row.syncedAt,
    lastSuccessAt: row.lastSuccessAt,
    lastFailureAt: row.lastFailureAt,
    lastFailureMessage: row.lastFailureMessage,
  }
}

class PostgresUsageRepository implements UsageRepository {
  constructor(private readonly handle: Handle) {}

  async get(connectionId: string): Promise<UsageSnapshotRecord | null> {
    const [row] = await this.handle
      .select()
      .from(usageSnapshots)
      .where(eq(usageSnapshots.connectionId, connectionId))
      .limit(1)
    return row ? toUsageSnapshot(row) : null
  }

  async put(record: UsageSnapshotRecord): Promise<void> {
    await this.handle
      .insert(usageSnapshots)
      .values({
        connectionId: record.connectionId,
        visibility: record.visibility,
        syncedAt: record.syncedAt,
        lastSuccessAt: record.lastSuccessAt,
        lastFailureAt: record.lastFailureAt,
        lastFailureCode: record.lastFailureCode,
        lastFailureMessage: record.lastFailureMessage,
        result: record.result === null ? null : record.result,
      })
      .onConflictDoUpdate({
        target: usageSnapshots.connectionId,
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
    connectionId: row.connectionId,
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
function parseCapabilities(value: unknown): ConnectionCapabilities {
  const parsed = (typeof value === 'object' && value !== null
    ? value
    : {}) as Partial<ConnectionCapabilities>
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
    await this.handle
      .insert(requestEvents)
      .values({
        id: event.id,
        occurredAt: event.occurredAt,
        connectionId: event.connectionId,
        model: event.model,
        gatewayKeyId: event.gatewayKeyId,
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
      .onConflictDoUpdate({
        target: requestEvents.id,
        set: {
          occurredAt: event.occurredAt,
          connectionId: event.connectionId,
          model: event.model,
          gatewayKeyId: event.gatewayKeyId,
          keyId: event.keyId,
          status: event.status,
          outcome: event.outcome,
          latencyMs: event.latencyMs,
          isStreaming: event.isStreaming,
          promptTokens: event.promptTokens,
          completionTokens: event.completionTokens,
          totalTokens: event.totalTokens,
          errorCode: event.errorCode,
        },
      })
  }

  async recordAttempt(attempt: Omit<RequestAttemptRecord, 'id'>): Promise<RequestAttemptRecord> {
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
      })
      .where(eq(requestAttempts.id, id))
  }

  async getEvent(id: string): Promise<RequestEventRecord | null> {
    const [row] = await this.handle
      .select()
      .from(requestEvents)
      .where(eq(requestEvents.id, id))
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

  async pruneEvents(before: Date): Promise<number> {
    const removed = await this.handle
      .delete(requestEvents)
      .where(lt(requestEvents.occurredAt, before))
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
    occurredAt: row.occurredAt,
    connectionId: row.connectionId,
    model: row.model,
    gatewayKeyId: row.gatewayKeyId,
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
  }
}

function eventFilter(filter: RequestHistoryFilter) {
  const conditions = []
  if (filter.connectionId !== undefined) {
    conditions.push(eq(requestEvents.connectionId, filter.connectionId))
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
  return conditions.length === 0 ? undefined : and(...conditions)
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
