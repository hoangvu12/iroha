import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

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
