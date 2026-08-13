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
 * One Owner-configured upstream brand the Gateway reaches. The ID is immutable
 * and client URLs are built on it; the display name, base URL, and lifecycle
 * state are not.
 *
 * The advanced transport columns encode what the Provider's Inference Adapter
 * may add and how the transport must behave. Auth header values and prefixes
 * are stored as plain text because they are not secrets: the secret lives on
 * the Upstream Key. Static headers, by contrast, are stored encrypted via the
 * SecretCipher and surfaced as a JSON-encoded array of {name, value} objects.
 *
 * Per-Key transport overrides do not exist; the Provider owns every transport,
 * authentication, retry, timeout, capability, and idempotency setting the
 * Gateway uses to reach the upstream. Per-Key base URLs do exist on
 * `upstream_keys.base_url`.
 */
export const providers = pgTable('providers', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  baseUrl: text('base_url').notNull(),
  allowInsecureHttp: boolean('allow_insecure_http').notNull(),
  enabled: boolean('enabled').notNull(),
  retryMaxAttempts: integer('retry_max_attempts').notNull().default(3),
  retryAmbiguousNetwork: boolean('retry_ambiguous_network').notNull().default(false),
  archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }),
  templateId: text('template_id'),
  capabilities: jsonb('capabilities').notNull(),
  /** Canonical authentication header name. Defaults to "Authorization". */
  authHeader: text('auth_header').notNull().default('authorization'),
  /** Plain-text prefix (e.g. "Bearer "); empty string means none. */
  authPrefix: text('auth_prefix').notNull().default('Bearer '),
  /** Encrypted JSON text of static [{name, value}] headers. Default is []. */
  staticHeadersEncrypted: text('static_headers_encrypted').notNull().default('[]'),
  /** Whether same-origin redirects are allowed. Default false: redirects rejected. */
  redirectAllowSameOrigin: boolean('redirect_allow_same_origin').notNull().default(false),
  connectionTimeoutMs: integer('connection_timeout_ms').notNull().default(10000),
  firstByteTimeoutMs: integer('first_byte_timeout_ms').notNull().default(20000),
  nonStreamingTotalTimeoutMs: integer('non_streaming_total_timeout_ms').notNull().default(120000),
  streamingIdleTimeoutMs: integer('streaming_idle_timeout_ms').notNull().default(30000),
  totalRetryTimeoutMs: integer('total_retry_timeout_ms').notNull().default(30000),
  /** The idempotency header the adapter accepts. Default: Idempotency-Key. */
  idempotencyHeader: text('idempotency_header').notNull().default('Idempotency-Key'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
})

/**
 * An optional group of Upstream Keys on one Provider that share Provider
 * billing or capacity. Deleting an account ungroups its keys instead of
 * deleting them.
 */
export const upstreamAccounts = pgTable('upstream_accounts', {
  id: text('id').primaryKey(),
  providerId: text('provider_id')
    .notNull()
    .references(() => providers.id, { onDelete: 'cascade' }),
  displayName: text('display_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
})

/**
 * An Upstream Key attached to one Provider. Only cipher output is stored, so a
 * copy of the database does not copy the Provider's keys. The optional
 * `base_url` column lets one Provider bind different keys to different upstream
 * endpoints (e.g. distinct regional or branded deployments). Model allow/deny
 * lists are JSON arrays, owned by the repository.
 */
export const upstreamKeys = pgTable('upstream_keys', {
  id: text('id').primaryKey(),
  providerId: text('provider_id')
    .notNull()
    .references(() => providers.id, { onDelete: 'cascade' }),
  /** Per-Key override of the Provider's base URL; null means inherit the Provider's. */
  baseUrl: text('base_url'),
  accountId: text('account_id').references(() => upstreamAccounts.id, {
    onDelete: 'set null',
  }),
  encryptedKey: text('encrypted_key').notNull(),
  health: text('health').notNull(),
  lastProbeAt: timestamp('last_probe_at', { withTimezone: true, mode: 'date' }),
  lastProbeVerdict: text('last_probe_verdict'),
  lastProbeReason: text('last_probe_reason'),
  healthReason: text('health_reason'),
  healthChangedAt: timestamp('health_changed_at', { withTimezone: true, mode: 'date' }),
  retryAfterAt: timestamp('retry_after_at', { withTimezone: true, mode: 'date' }),
  healthScope: text('health_scope').notNull().default('key'),
  healthScopeId: text('health_scope_id'),
  healthModel: text('health_model'),
  allowedModels: jsonb('allowed_models'),
  deniedModels: jsonb('denied_models'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
})

/**
 * An application credential the Owner issues. The secret itself never lands
 * here: only its hash is stored, and the public id is what applications and
 * lists refer to. `cors_origins` is a JSON array of exact origins allowed to
 * call from a browser; an empty array disables CORS for the key entirely.
 */
export const gatewayKeys = pgTable('gateway_keys', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  secretHash: text('secret_hash').notNull(),
  scope: jsonb('scope').notNull(),
  /** JSON array of exact origin strings; empty means no CORS for this key. */
  corsOrigins: jsonb('cors_origins').notNull().default('[]'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
  revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
})

/**
 * One model known to a Provider's catalog. Excluded rows are kept so an Owner
 * block survives synchronization. Capability overrides are a nullable JSON
 * object of booleans.
 */
export const modelCatalogEntries = pgTable(
  'model_catalog_entries',
  {
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    modelId: text('model_id').notNull(),
    source: text('source').notNull(),
    excluded: boolean('excluded').notNull(),
    overrides: jsonb('overrides'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.providerId, table.modelId] }) }),
)

/** The last synchronization outcome of one Provider's catalog. */
export const modelCatalogSync = pgTable('model_catalog_sync', {
  providerId: text('provider_id')
    .primaryKey()
    .references(() => providers.id, { onDelete: 'cascade' }),
  syncedAt: timestamp('synced_at', { withTimezone: true, mode: 'date' }),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true, mode: 'date' }),
  lastFailureAt: timestamp('last_failure_at', { withTimezone: true, mode: 'date' }),
  lastFailureMessage: text('last_failure_message'),
})

/**
 * The last usage polling outcome of one Provider. `result` holds the last
 * successful normalized reading; `lastFailureAt` and `lastFailureMessage` are
 * kept independently so the Owner sees the latest error without losing the
 * previous successful result.
 */
export const usageSnapshots = pgTable('usage_snapshots', {
  providerId: text('provider_id')
    .primaryKey()
    .references(() => providers.id, { onDelete: 'cascade' }),
  /** The visibility the configured Usage Adapter declares. */
  visibility: text('visibility').notNull(),
  syncedAt: timestamp('synced_at', { withTimezone: true, mode: 'date' }),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true, mode: 'date' }),
  lastFailureAt: timestamp('last_failure_at', { withTimezone: true, mode: 'date' }),
  lastFailureCode: text('last_failure_code'),
  lastFailureMessage: text('last_failure_message'),
  /** jsonb of the last successful normalized reading, or null. */
  result: jsonb('result'),
})

/**
 * One inference call's metadata, kept for the Owner's history view.
 *
 * The ID is the same correlation ID returned to the caller and stored on
 * every error response, so the Owner can correlate a failure with what they
 * see on the wire. `keyId` is the public identity of the Upstream Key the
 * request actually used (the value is the database row ID; the secret
 * material is never reachable from this column). `gatewayKeyId` is the
 * public identity of the Gateway Key the application used.
 *
 * Token usage is what the Provider returned in the upstream response body.
 * It is the Provider's own number, never Iroha's count, and is recorded only
 * when the Provider supplied it. No prompts, no responses, no upstream
 * message bodies.
 */
export const requestEvents = pgTable('request_events', {
  id: text('id').primaryKey(),
  occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
  providerId: text('provider_id')
    .notNull()
    .references(() => providers.id, { onDelete: 'cascade' }),
  model: text('model').notNull(),
  /** Public identity of the Gateway Key the application presented. */
  gatewayKeyId: text('gateway_key_id'),
  /** Public identity of the Upstream Key the request actually used. */
  keyId: text('key_id'),
  /** Final HTTP status Iroha returned to the caller. */
  status: integer('status').notNull(),
  outcome: text('outcome').notNull(),
  latencyMs: integer('latency_ms').notNull(),
  isStreaming: boolean('is_streaming').notNull(),
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  totalTokens: integer('total_tokens'),
  /** Stable Iroha error code on failure; null on success. */
  errorCode: text('error_code'),
})

/**
 * One attempt within an inference call's retry trail. Each row describes one
 * upstream call: which key, when it started and ended, what status it
 * produced, and what Iroha decided to do with it next (retry, skip, succeed).
 * No upstream bodies, no headers, no secrets.
 */
export const requestAttempts = pgTable('request_attempts', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  requestId: text('request_id')
    .notNull()
    .references(() => requestEvents.id, { onDelete: 'cascade' }),
  attemptNumber: integer('attempt_number').notNull(),
  /** Public identity of the Upstream Key tried on this attempt. */
  keyId: text('key_id'),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  status: integer('status'),
  /** 'success' | 'failure' | 'skipped' (skipped when no key was eligible) */
  outcome: text('outcome').notNull(),
  errorCode: text('error_code'),
  retryAfterSeconds: integer('retry_after_seconds'),
})

/**
 * One background job's durable status. The scheduler writes one row per job and
 * updates it inside a database-level claim so two overlapping invocations of
 * the same job cannot both succeed. `status` is the current state (`idle`,
 * `running`, `succeeded`, `failed`); the `last_*` fields describe the most
 * recent completed run. `last_error_message` is structural text only, never
 * upstream body content that could echo a secret.
 */
export const backgroundJobs = pgTable('background_jobs', {
  jobId: text('job_id').primaryKey(),
  lastStartedAt: timestamp('last_started_at', { withTimezone: true, mode: 'date' }),
  lastCompletedAt: timestamp('last_completed_at', { withTimezone: true, mode: 'date' }),
  status: text('status').notNull(),
  lastOutcome: text('last_outcome'),
  lastErrorCode: text('last_error_code'),
  lastErrorMessage: text('last_error_message'),
  lastDurationMs: integer('last_duration_ms'),
  lastAffectedCount: integer('last_affected_count'),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
})
