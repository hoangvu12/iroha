import { boolean, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * The PostgreSQL schema. It has its own migration history under
 * `migrations/postgres/` and is never imported outside
 * `src/persistence/postgres/`.
 */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
})

/**
 * The sole Owner. `id` holds one constant value, so the primary key — not an
 * application check — is what makes a second Owner impossible.
 */
export const owner = pgTable('owner', {
  id: text('id').primaryKey(),
  username: text('username').notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  passwordChangedAt: timestamp('password_changed_at', {
    withTimezone: true,
    mode: 'date',
  }).notNull(),
})

export const ownerSessions = pgTable('owner_sessions', {
  id: text('id').primaryKey(),
  secretHash: text('secret_hash').notNull(),
  csrfToken: text('csrf_token').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  userAgent: text('user_agent'),
})

export const auditEvents = pgTable('audit_events', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
  action: text('action').notNull(),
  outcome: text('outcome').notNull(),
  /** Never holds a secret value. */
  detail: jsonb('detail'),
})

/**
 * One Owner-configured account or server. The ID is immutable and client URLs
 * are built on it; the display name, base URL, and lifecycle state are not.
 */
export const providerConnections = pgTable('provider_connections', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  baseUrl: text('base_url').notNull(),
  allowInsecureHttp: boolean('allow_insecure_http').notNull(),
  enabled: boolean('enabled').notNull(),
  archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }),
  templateId: text('template_id'),
  capabilities: jsonb('capabilities').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
})

/**
 * An Upstream Key attached to one Provider Connection. Only cipher output is
 * stored, so a copy of the database does not copy the Provider's keys.
 */
export const upstreamKeys = pgTable('upstream_keys', {
  id: text('id').primaryKey(),
  connectionId: text('connection_id')
    .notNull()
    .references(() => providerConnections.id, { onDelete: 'cascade' }),
  encryptedKey: text('encrypted_key').notNull(),
  health: text('health').notNull(),
  lastProbeAt: timestamp('last_probe_at', { withTimezone: true, mode: 'date' }),
  lastProbeVerdict: text('last_probe_verdict'),
  lastProbeReason: text('last_probe_reason'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
})

/**
 * An application credential the Owner issues. The secret itself never lands
 * here: only its hash is stored, and the public id is what applications and
 * lists refer to.
 */
export const gatewayKeys = pgTable('gateway_keys', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  secretHash: text('secret_hash').notNull(),
  scope: jsonb('scope').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
  revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
})

/**
 * One model known to a Provider Connection's catalog. Excluded rows are kept so
 * an Owner block survives synchronization. Capability overrides are a nullable
 * JSON object of booleans.
 */
export const modelCatalogEntries = pgTable(
  'model_catalog_entries',
  {
    connectionId: text('connection_id')
      .notNull()
      .references(() => providerConnections.id, { onDelete: 'cascade' }),
    modelId: text('model_id').notNull(),
    source: text('source').notNull(),
    excluded: boolean('excluded').notNull(),
    overrides: jsonb('overrides'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.connectionId, table.modelId] }) }),
)

/** The last synchronization outcome of one connection's catalog. */
export const modelCatalogSync = pgTable('model_catalog_sync', {
  connectionId: text('connection_id')
    .primaryKey()
    .references(() => providerConnections.id, { onDelete: 'cascade' }),
  syncedAt: timestamp('synced_at', { withTimezone: true, mode: 'date' }),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true, mode: 'date' }),
  lastFailureAt: timestamp('last_failure_at', { withTimezone: true, mode: 'date' }),
  lastFailureMessage: text('last_failure_message'),
})
