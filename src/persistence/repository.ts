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

/** The repositories reachable inside and outside a transaction alike. */
export interface Repositories {
  readonly settings: SettingsRepository
  readonly owner: OwnerRepository
  readonly sessions: SessionRepository
  readonly audit: AuditRepository
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
