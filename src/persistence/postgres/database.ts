import { join } from 'node:path'
import { desc, eq, lt, sql } from 'drizzle-orm'
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
  type Database,
  type KeyProbeVerdict,
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
import { auditEvents, owner, ownerSessions, providerConnections, settings, upstreamKeys } from './schema.ts'

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
    const [row] = await this.handle.insert(providerConnections).values(connection).returning()
    return toConnection(row ?? connection)
  }

  async updateConnection(
    id: string,
    patch: ProviderConnectionPatch,
    at: Date,
  ): Promise<ProviderConnectionRecord | null> {
    const changed = { ...patch, updatedAt: at }
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
