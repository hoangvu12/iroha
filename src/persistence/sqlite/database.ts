import { Database as BunSqlite } from 'bun:sqlite'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { desc, eq, lt, sql } from 'drizzle-orm'
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import type { SqliteConfiguration } from '../../config/environment.ts'
import {
  DatabaseUnavailableError,
  OWNER_ROW_ID,
  type AuditEventRecord,
  type AuditOutcome,
  type AuditRepository,
  type Database,
  type OwnerRecord,
  type OwnerRepository,
  type Repositories,
  type SessionRecord,
  type SessionRepository,
  type SettingRecord,
  type SettingsRepository,
} from '../repository.ts'
import { auditEvents, owner, ownerSessions, settings } from './schema.ts'

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
