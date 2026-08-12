import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * The SQLite schema. It has its own migration history under
 * `migrations/sqlite/` and is never imported outside `src/persistence/sqlite/`.
 *
 * Timestamps are stored as epoch milliseconds and surfaced as UTC `Date`
 * values, matching the PostgreSQL track's `timestamp with time zone`.
 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  /** JSON text. The repository owns encoding so both dialects return `unknown`. */
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

/**
 * The sole Owner. `id` holds one constant value, so the primary key — not an
 * application check — is what makes a second Owner impossible.
 */
export const owner = sqliteTable('owner', {
  id: text('id').primaryKey(),
  username: text('username').notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  passwordChangedAt: integer('password_changed_at', { mode: 'timestamp_ms' }).notNull(),
})

export const ownerSessions = sqliteTable('owner_sessions', {
  id: text('id').primaryKey(),
  secretHash: text('secret_hash').notNull(),
  csrfToken: text('csrf_token').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  userAgent: text('user_agent'),
})

export const auditEvents = sqliteTable('audit_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }).notNull(),
  action: text('action').notNull(),
  outcome: text('outcome').notNull(),
  /** JSON text, like `settings.value`. Never holds a secret value. */
  detail: text('detail'),
})

/**
 * One Owner-configured account or server. The ID is immutable and client URLs
 * are built on it; the display name, base URL, and lifecycle state are not.
 *
 * The advanced transport columns encode what the connection's Inference Adapter
 * may add and how the transport must behave. Auth header values and prefixes are
 * stored as plain text because they are not secrets: the secret lives on the
 * Upstream Key. Static headers, by contrast, are stored encrypted via the
 * SecretCipher and surfaced as a JSON-encoded array of {name, value} objects.
 */
export const providerConnections = sqliteTable('provider_connections', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  baseUrl: text('base_url').notNull(),
  allowInsecureHttp: integer('allow_insecure_http', { mode: 'boolean' }).notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  retryMaxAttempts: integer('retry_max_attempts').notNull().default(3),
  retryAmbiguousNetwork: integer('retry_ambiguous_network', { mode: 'boolean' })
    .notNull()
    .default(false),
  archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
  templateId: text('template_id'),
  /** JSON text owned by the repository, like the gateway key scope. */
  capabilities: text('capabilities').notNull(),
  /** Canonical authentication header name. Defaults to "Authorization". */
  authHeader: text('auth_header').notNull().default('authorization'),
  /** Plain-text prefix (e.g. "Bearer "); empty string means none. */
  authPrefix: text('auth_prefix').notNull().default('Bearer '),
  /** Encrypted JSON text of static [{name, value}] headers. Default is []. */
  staticHeadersEncrypted: text('static_headers_encrypted').notNull().default('[]'),
  /** Whether same-origin redirects are allowed. Default false: redirects rejected. */
  redirectAllowSameOrigin: integer('redirect_allow_same_origin', { mode: 'boolean' })
    .notNull()
    .default(false),
  connectionTimeoutMs: integer('connection_timeout_ms').notNull().default(10000),
  firstByteTimeoutMs: integer('first_byte_timeout_ms').notNull().default(20000),
  nonStreamingTotalTimeoutMs: integer('non_streaming_total_timeout_ms').notNull().default(120000),
  streamingIdleTimeoutMs: integer('streaming_idle_timeout_ms').notNull().default(30000),
  totalRetryTimeoutMs: integer('total_retry_timeout_ms').notNull().default(30000),
  /** The idempotency header the adapter accepts. Default: Idempotency-Key. */
  idempotencyHeader: text('idempotency_header').notNull().default('Idempotency-Key'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

/**
 * An optional group of Upstream Keys on one Provider Connection that share
 * Provider billing or capacity. Deleting an account ungroups its keys instead
 * of deleting them.
 */
export const upstreamAccounts = sqliteTable('upstream_accounts', {
  id: text('id').primaryKey(),
  connectionId: text('connection_id')
    .notNull()
    .references(() => providerConnections.id, { onDelete: 'cascade' }),
  displayName: text('display_name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

/**
 * An Upstream Key attached to one Provider Connection. Only cipher output is
 * stored, so a copy of the database does not copy the Provider's keys. Model
 * allow/deny lists are JSON text, owned by the repository like settings.
 */
export const upstreamKeys = sqliteTable('upstream_keys', {
  id: text('id').primaryKey(),
  connectionId: text('connection_id')
    .notNull()
    .references(() => providerConnections.id, { onDelete: 'cascade' }),
  accountId: text('account_id').references(() => upstreamAccounts.id, {
    onDelete: 'set null',
  }),
  encryptedKey: text('encrypted_key').notNull(),
  health: text('health').notNull(),
  lastProbeAt: integer('last_probe_at', { mode: 'timestamp_ms' }),
  lastProbeVerdict: text('last_probe_verdict'),
  lastProbeReason: text('last_probe_reason'),
  healthReason: text('health_reason'),
  healthChangedAt: integer('health_changed_at', { mode: 'timestamp_ms' }),
  retryAfterAt: integer('retry_after_at', { mode: 'timestamp_ms' }),
  healthScope: text('health_scope').notNull().default('key'),
  healthScopeId: text('health_scope_id'),
  healthModel: text('health_model'),
  allowedModels: text('allowed_models'),
  deniedModels: text('denied_models'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

/**
 * An application credential the Owner issues. The secret itself never lands
 * here: only its hash is stored, and the public id is what applications and
 * lists refer to. Scope is JSON text, owned by the repository like settings.
 * `cors_origins` is a JSON array of exact origins allowed to call from a
 * browser; an empty array disables CORS for the key entirely.
 */
export const gatewayKeys = sqliteTable('gateway_keys', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  secretHash: text('secret_hash').notNull(),
  scope: text('scope').notNull(),
  /** JSON array of exact origin strings; empty means no CORS for this key. */
  corsOrigins: text('cors_origins').notNull().default('[]'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
  revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
})

/**
 * One model known to a Provider Connection's catalog. Excluded rows are kept so
 * an Owner block survives synchronization. Capability overrides are JSON text.
 */
export const modelCatalogEntries = sqliteTable(
  'model_catalog_entries',
  {
    connectionId: text('connection_id')
      .notNull()
      .references(() => providerConnections.id, { onDelete: 'cascade' }),
    modelId: text('model_id').notNull(),
    source: text('source').notNull(),
    excluded: integer('excluded', { mode: 'boolean' }).notNull(),
    overrides: text('overrides'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.connectionId, table.modelId] }) }),
)

/** The last synchronization outcome of one connection's catalog. */
export const modelCatalogSync = sqliteTable('model_catalog_sync', {
  connectionId: text('connection_id')
    .primaryKey()
    .references(() => providerConnections.id, { onDelete: 'cascade' }),
  syncedAt: integer('synced_at', { mode: 'timestamp_ms' }),
  lastSuccessAt: integer('last_success_at', { mode: 'timestamp_ms' }),
  lastFailureAt: integer('last_failure_at', { mode: 'timestamp_ms' }),
  lastFailureMessage: text('last_failure_message'),
})

/**
 * The last usage polling outcome of one connection. `result` holds the last
 * successful normalized reading; `lastFailureAt` and `lastFailureMessage` are
 * kept independently so the Owner sees the latest error without losing the
 * previous successful result.
 */
export const usageSnapshots = sqliteTable('usage_snapshots', {
  connectionId: text('connection_id')
    .primaryKey()
    .references(() => providerConnections.id, { onDelete: 'cascade' }),
  /** The visibility the configured Usage Adapter declares. */
  visibility: text('visibility').notNull(),
  syncedAt: integer('synced_at', { mode: 'timestamp_ms' }),
  lastSuccessAt: integer('last_success_at', { mode: 'timestamp_ms' }),
  lastFailureAt: integer('last_failure_at', { mode: 'timestamp_ms' }),
  lastFailureCode: text('last_failure_code'),
  lastFailureMessage: text('last_failure_message'),
  /** JSON text of the last successful normalized reading, or null. */
  result: text('result'),
})
