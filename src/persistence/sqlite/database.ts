import { Database as BunSqlite } from 'bun:sqlite'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { and, desc, eq, lt, sql } from 'drizzle-orm'
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import type { SqliteConfiguration } from '../../config/environment.ts'
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
  type UpstreamAccountPatch,
  type UpstreamAccountRecord,
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
  upstreamAccounts,
  upstreamKeys,
} from './schema.ts'

const MIGRATIONS_FOLDER = join(import.meta.dir, '../../../migrations/sqlite')

type Handle = BunSQLiteDatabase<Record<string, never>>

export function openSqliteDatabase(config: SqliteConfiguration): Database {
  const client = createClient(config)
  const handle = drizzle(client)

  return new SqliteDatabase(config, client, handle)
}

function createClient(config: SqliteConfiguration): BunSqlite {
  try {
    if (!config.ephemeral) {
      mkdirSync(dirname(config.file), { recursive: true })
    }

    const client = new BunSqlite(config.file, { create: true })
    // Concurrent readers alongside the writer, and enforced foreign keys, are
    // assumptions the PostgreSQL track already makes.
    client.exec('pragma journal_mode = WAL')
    client.exec('pragma foreign_keys = ON')
    client.exec('pragma busy_timeout = 5000')
    return client
  } catch (cause) {
    throw new DatabaseUnavailableError(`Cannot open ${config.describe}`, { cause })
  }
}

class SqliteDatabase implements Database {
  readonly dialect = 'sqlite' as const
  readonly describe: string
  readonly settings: SettingsRepository
  readonly owner: OwnerRepository
  readonly sessions: SessionRepository
  readonly audit: AuditRepository
  readonly providers: ProviderRepository
  readonly gatewayKeys: GatewayKeyRepository
  readonly modelCatalog: ModelCatalogRepository

  /**
   * `bun:sqlite` is one synchronous connection, so two overlapping
   * transactions would interleave their statements. Work is chained instead of
   * rejected, which keeps callers simple in the single-process runtime.
   */
  #transactionQueue: Promise<unknown> = Promise.resolve()

  constructor(
    config: SqliteConfiguration,
    private readonly client: BunSqlite,
    private readonly handle: Handle,
  ) {
    this.describe = config.describe
    this.settings = new SqliteSettingsRepository(handle)
    this.owner = new SqliteOwnerRepository(handle)
    this.sessions = new SqliteSessionRepository(handle)
    this.audit = new SqliteAuditRepository(handle)
    this.providers = new SqliteProviderRepository(handle)
    this.gatewayKeys = new SqliteGatewayKeyRepository(handle)
    this.modelCatalog = new SqliteModelCatalogRepository(handle)
  }

  /**
   * `bun:sqlite` holds one connection, so the same repositories serve both
   * inside and outside a transaction.
   */
  get #repositories(): Repositories {
    return {
      settings: this.settings,
      owner: this.owner,
      sessions: this.sessions,
      audit: this.audit,
      providers: this.providers,
      gatewayKeys: this.gatewayKeys,
      modelCatalog: this.modelCatalog,
    }
  }

  async migrate(): Promise<void> {
    try {
      migrate(this.handle, { migrationsFolder: MIGRATIONS_FOLDER })
    } catch (cause) {
      throw new DatabaseUnavailableError(`Migrating ${this.describe} failed`, { cause })
    }
  }

  async ping(): Promise<void> {
    try {
      this.handle.get(sql`select 1`)
    } catch (cause) {
      throw new DatabaseUnavailableError(`${this.describe} is not responding`, { cause })
    }
  }

  transaction<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    const run = this.#transactionQueue.then(async () => {
      this.handle.run(sql`begin immediate`)
      try {
        const result = await work(this.#repositories)
        this.handle.run(sql`commit`)
        return result
      } catch (error) {
        this.handle.run(sql`rollback`)
        throw error
      }
    })

    // The queue must survive a failed transaction, so it tracks completion
    // rather than success.
    this.#transactionQueue = run.catch(() => undefined)
    return run
  }

  async close(): Promise<void> {
    this.client.close()
  }
}

class SqliteSettingsRepository implements SettingsRepository {
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
    const row = { key, value: JSON.stringify(value ?? null), updatedAt: new Date() }

    await this.handle
      .insert(settings)
      .values(row)
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: row.value, updatedAt: row.updatedAt },
      })

    return toRecord(row)
  }

  async remove(key: string): Promise<boolean> {
    const removed = await this.handle
      .delete(settings)
      .where(eq(settings.key, key))
      .returning({ key: settings.key })
    return removed.length > 0
  }
}

function toRecord(row: { key: string; value: string; updatedAt: Date }): SettingRecord {
  return { key: row.key, value: JSON.parse(row.value) as unknown, updatedAt: row.updatedAt }
}

class SqliteOwnerRepository implements OwnerRepository {
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

class SqliteSessionRepository implements SessionRepository {
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

class SqliteAuditRepository implements AuditRepository {
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
        // Absent detail is stored as SQL NULL rather than the JSON text
        // `null`, so both dialects hold the same thing.
        detail: event.detail === undefined ? null : JSON.stringify(event.detail),
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
  detail: string | null
}): AuditEventRecord {
  return {
    id: row.id,
    occurredAt: row.occurredAt,
    action: row.action,
    outcome: row.outcome as AuditOutcome,
    detail: row.detail === null ? null : (JSON.parse(row.detail) as unknown),
  }
}

class SqliteProviderRepository implements ProviderRepository {
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
    const [row] = await this.handle.select().from(upstreamKeys).where(eq(upstreamKeys.id, id)).limit(1)
    return row ? toKey(row) : null
  }

  async insertKey(key: UpstreamKeyRecord): Promise<UpstreamKeyRecord> {
    const encoded = encodeKey(key)
    const [row] = await this.handle.insert(upstreamKeys).values(encoded).returning()
    return toKey(row ?? encoded)
  }

  async updateKey(
    id: string,
    patch: UpstreamKeyPatch,
    at: Date,
  ): Promise<UpstreamKeyRecord | null> {
    const changed = { ...encodePatch(patch), updatedAt: at }
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

/** SQLite keeps the model lists as JSON text, so the record's arrays are encoded here. */
function encodeKey(key: UpstreamKeyRecord): KeyRow {
  return {
    ...key,
    allowedModels: encodeModels(key.allowedModels),
    deniedModels: encodeModels(key.deniedModels),
  }
}

/** Patches carry the same JSON encoding for the same two columns. */
function encodePatch(patch: UpstreamKeyPatch): Partial<KeyRow> {
  const encoded = { ...patch } as Record<string, unknown>
  if (patch.allowedModels !== undefined) {
    encoded.allowedModels = encodeModels(patch.allowedModels)
  }
  if (patch.deniedModels !== undefined) {
    encoded.deniedModels = encodeModels(patch.deniedModels)
  }
  return encoded as Partial<KeyRow>
}

function encodeModels(models: readonly string[] | null | undefined): string | null {
  return models === null || models === undefined ? null : JSON.stringify(models)
}

class SqliteGatewayKeyRepository implements GatewayKeyRepository {
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
    const [row] = await this.handle
      .insert(gatewayKeys)
      .values({
        id: key.id,
        name: key.name,
        secretHash: key.secretHash,
        scope: JSON.stringify(key.scope),
        createdAt: key.createdAt,
        lastUsedAt: key.lastUsedAt,
        revokedAt: key.revokedAt,
      })
      .returning()
    return row === undefined ? toGatewayKey({ ...key, scope: JSON.stringify(key.scope) }) : toGatewayKey(row)
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
    scope: JSON.parse(row.scope) as readonly GatewayKeyScopeEntry[],
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
    accountId: row.accountId,
    encryptedKey: row.encryptedKey,
    health: row.health as UpstreamKeyHealth,
    lastProbeAt: row.lastProbeAt,
    lastProbeVerdict: row.lastProbeVerdict as KeyProbeVerdict | null,
    lastProbeReason: row.lastProbeReason,
    allowedModels: decodeModels(row.allowedModels),
    deniedModels: decodeModels(row.deniedModels),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function decodeModels(raw: string | null): readonly string[] | null {
  if (raw === null) return null
  const parsed = JSON.parse(raw) as unknown
  return Array.isArray(parsed) ? (parsed as string[]) : null
}

class SqliteModelCatalogRepository implements ModelCatalogRepository {
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
    const encoded = JSON.stringify(overrides)
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
        overrides: encoded,
        createdAt: at,
        updatedAt: at,
      })
    } else {
      await this.handle
        .update(modelCatalogEntries)
        .set({ overrides: encoded, updatedAt: at })
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
    overrides: row.overrides === null ? null : (JSON.parse(row.overrides) as Partial<ConnectionCapabilities>),
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

/** JSON text -> capabilities. A corrupted row must not silently become defaults. */
function parseCapabilities(raw: string): ConnectionCapabilities {
  const value = JSON.parse(raw) as Partial<ConnectionCapabilities>
  return {
    chat: value.chat === true,
    streaming: value.streaming === true,
    tools: value.tools === true,
    structuredOutput: value.structuredOutput === true,
    responses: value.responses === true,
  }
}

/** JSON text -> capabilities. A corrupted row must not silently become defaults. */
