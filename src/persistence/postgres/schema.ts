import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

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
