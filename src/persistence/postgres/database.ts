import { join } from 'node:path'
import { and, desc, eq, lt, sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import type { PostgresConfiguration } from '../../config/environment.ts'
import {
  DatabaseUnavailableError,
  OWNER_ROW_ID,
  type AuditEventRecord,
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
  type SessionRecord,
  type SessionRepository,
  type SettingRecord,
  type SettingsRepository,
  type UpstreamKeyHealth,
  type UpstreamKeyPatch,
  type UpstreamKeyRecord,
} from '../repository.ts'
import {
  auditEvents,
  gatewayKeys,
  modelCatalogEntries,
  modelCatalogSync,
  owner,
  ownerSessions,
  providerConnections,
  settings,
  upstreamKeys,
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
    const [row] = await this.handle
      .insert(providerConnections)
      .values({ ...connection, capabilities: JSON.stringify(connection.capabilities) })
      .returning()
    return toConnection(row ?? { ...connection, capabilities: JSON.stringify(connection.capabilities) })
  }

  async updateConnection(
    id: string,
    patch: ProviderConnectionPatch,
    at: Date,
  ): Promise<ProviderConnectionRecord | null> {
    const { capabilities, ...rest } = patch
    const changed = {
      ...rest,
      ...(capabilities === undefined ? {} : { capabilities: JSON.stringify(capabilities) }),
      updatedAt: at,
    }
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

  async deleteKeysForConnection(connectionId: string): Promise<number> {
    const removed = await this.handle
      .delete(upstreamKeys)
      .where(eq(upstreamKeys.connectionId, connectionId))
      .returning({ id: upstreamKeys.id })
    return removed.length
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
    const [row] = await this.handle.insert(gatewayKeys).values(key).returning()
    return toGatewayKey(row ?? key)
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
}

type GatewayKeyRow = typeof gatewayKeys.$inferSelect

function toGatewayKey(row: GatewayKeyRow): GatewayKeyRecord {
  return {
    id: row.id,
    name: row.name,
    secretHash: row.secretHash,
    scope: row.scope as readonly GatewayKeyScopeEntry[],
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
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
    archivedAt: row.archivedAt,
    templateId: row.templateId,
    capabilities: parseCapabilities(row.capabilities),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function toKey(row: KeyRow): UpstreamKeyRecord {
  return {
    id: row.id,
    connectionId: row.connectionId,
    encryptedKey: row.encryptedKey,
    health: row.health as UpstreamKeyHealth,
    lastProbeAt: row.lastProbeAt,
    lastProbeVerdict: row.lastProbeVerdict as KeyProbeVerdict | null,
    lastProbeReason: row.lastProbeReason,
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
