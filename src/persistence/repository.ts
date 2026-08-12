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
 * One Owner-configured account or server the Gateway reaches a Provider
 * through. The ID is immutable for the connection's whole life because client
 * URLs are built on it; everything else may change.
 */
export interface ProviderConnectionRecord {
  readonly id: string
  readonly displayName: string
  /** The Provider's OpenAI-compatible base URL, exactly as the Owner gave it. */
  readonly baseUrl: string
  /** The explicit per-connection exception that permits plain HTTP. */
  readonly allowInsecureHttp: boolean
  readonly enabled: boolean
  /** Set when the connection is archived; null while it is in active use. */
  readonly archivedAt: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

/**
 * The durable result of the last low-cost test of an Upstream Key. Reasons are
 * structural descriptions and never contain the key or any secret.
 */
export type KeyProbeVerdict = 'usable' | 'rejected' | 'inconclusive'

/**
 * The Key Health states a key can hold before the full Key Health engine
 * exists: Unverified until tested or manually activated, Active once usable,
 * Disabled when the Owner turns it off. Later tickets widen this without
 * renaming it.
 */
export type UpstreamKeyHealth = 'unverified' | 'active' | 'disabled'

/**
 * One Upstream Key attached to a Provider Connection. The key material itself
 * appears only as cipher output, so copying the database does not copy the
 * Provider's keys.
 */
export interface UpstreamKeyRecord {
  readonly id: string
  readonly connectionId: string
  readonly encryptedKey: string
  readonly health: UpstreamKeyHealth
  readonly lastProbeAt: Date | null
  readonly lastProbeVerdict: KeyProbeVerdict | null
  readonly lastProbeReason: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** Only fields the Owner may edit. The ID is never patchable. */
export interface ProviderConnectionPatch {
  readonly displayName?: string
  readonly baseUrl?: string
  readonly allowInsecureHttp?: boolean
  readonly enabled?: boolean
  readonly archivedAt?: Date | null
}

export interface UpstreamKeyPatch {
  readonly health?: UpstreamKeyHealth
  readonly lastProbeAt?: Date | null
  readonly lastProbeVerdict?: KeyProbeVerdict | null
  readonly lastProbeReason?: string | null
}

export interface ProviderRepository {
  /** Every connection, most recently created first, archived ones included. */
  listConnections(): Promise<readonly ProviderConnectionRecord[]>
  getConnection(id: string): Promise<ProviderConnectionRecord | null>
  insertConnection(connection: ProviderConnectionRecord): Promise<ProviderConnectionRecord>
  /** Applies only the supplied fields and moves `updatedAt`. Null when unknown. */
  updateConnection(
    id: string,
    patch: ProviderConnectionPatch,
    at: Date,
  ): Promise<ProviderConnectionRecord | null>
  /** Returns whether a connection existed to remove. */
  deleteConnection(id: string): Promise<boolean>

  /** Keys of one connection, oldest first. */
  listKeys(connectionId: string): Promise<readonly UpstreamKeyRecord[]>
  getKey(id: string): Promise<UpstreamKeyRecord | null>
  insertKey(key: UpstreamKeyRecord): Promise<UpstreamKeyRecord>
  /** Applies only the supplied fields and moves `updatedAt`. Null when unknown. */
  updateKey(id: string, patch: UpstreamKeyPatch, at: Date): Promise<UpstreamKeyRecord | null>
  /** Removes every key of a connection, returning how many were removed. */
  deleteKeysForConnection(connectionId: string): Promise<number>
}

/**
 * One Provider Connection a Gateway Key permits its application to use and
 * discover. `models` is `null` when every model on the connection is allowed,
 * or the exact upstream model IDs the key is restricted to.
 */
export interface GatewayKeyScopeEntry {
  readonly connectionId: string
  readonly models: readonly string[] | null
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
  /** Which Provider Connections the key may use and discover, and how. */
  readonly scope: readonly GatewayKeyScopeEntry[]
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
}

/** The repositories reachable inside and outside a transaction alike. */
export interface Repositories {
  readonly settings: SettingsRepository
  readonly owner: OwnerRepository
  readonly sessions: SessionRepository
  readonly audit: AuditRepository
  readonly providers: ProviderRepository
  readonly gatewayKeys: GatewayKeyRepository
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
