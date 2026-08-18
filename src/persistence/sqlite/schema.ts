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
export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  handle: text('handle').notNull().unique(),
  displayName: text('display_name').notNull(),
  baseUrl: text('base_url').notNull(),
  logoDomain: text('logo_domain'),
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
 * An optional group of Upstream Keys on one Provider that share Provider
 * billing or capacity. Deleting an account ungroups its keys instead of
 * deleting them.
 */
export const upstreamAccounts = sqliteTable('upstream_accounts', {
  id: text('id').primaryKey(),
  providerId: text('provider_id')
    .notNull()
    .references(() => providers.id, { onDelete: 'cascade' }),
  displayName: text('display_name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

/**
 * An Upstream Key attached to one Provider. Only cipher output is stored, so a
 * copy of the database does not copy the Provider's keys. The optional
 * `base_url` column lets one Provider bind different keys to different upstream
 * endpoints (e.g. distinct regional or branded deployments). Model allow/deny
 * lists are JSON text, owned by the repository like settings.
 */
export const upstreamKeys = sqliteTable('upstream_keys', {
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
  accessMode: text('access_mode').notNull().default('selected'),
  revision: integer('revision').notNull().default(1),
  /** JSON array of exact origin strings; empty means no CORS for this key. */
  corsOrigins: text('cors_origins').notNull().default('[]'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
  revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
})

/**
 * One model known to a Provider's catalog. Excluded rows are kept so an Owner
 * block survives synchronization. Capability overrides are JSON text.
 */
export const modelCatalogEntries = sqliteTable(
  'model_catalog_entries',
  {
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    modelId: text('model_id').notNull(),
    source: text('source').notNull(),
    excluded: integer('excluded', { mode: 'boolean' }).notNull(),
    overrides: text('overrides'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.providerId, table.modelId] }) }),
)

/** The last synchronization outcome of one Provider's catalog. */
export const modelCatalogSync = sqliteTable('model_catalog_sync', {
  providerId: text('provider_id')
    .primaryKey()
    .references(() => providers.id, { onDelete: 'cascade' }),
  syncedAt: integer('synced_at', { mode: 'timestamp_ms' }),
  lastSuccessAt: integer('last_success_at', { mode: 'timestamp_ms' }),
  lastFailureAt: integer('last_failure_at', { mode: 'timestamp_ms' }),
  lastFailureMessage: text('last_failure_message'),
})

/**
 * One Upstream Key's Key Model Availability: the models that key is known to
 * call, discovered from the Provider (ADR-0023).
 *
 * Deliberately not part of `model_catalog_entries`. That table is the Model
 * Catalog — what a caller may ask for, carrying Owner exclusions and capability
 * overrides. This one is discovered fact with no Owner input, and it answers a
 * different question: which Upstream Keys should be preferred for a model.
 *
 * A key with no row here has unknown availability and is never restricted by
 * it. `stale` marks a list retained through a failed rediscovery, which stays
 * usable — the previous answer beats no answer.
 */
export const keyModelAvailability = sqliteTable('key_model_availability', {
  keyId: text('key_id')
    .primaryKey()
    .references(() => upstreamKeys.id, { onDelete: 'cascade' }),
  providerId: text('provider_id')
    .notNull()
    .references(() => providers.id, { onDelete: 'cascade' }),
  /** JSON array of exact model IDs. The repository owns encoding. */
  models: text('models').notNull(),
  /** When the Provider last answered; drives the age limit that forces a re-read. */
  discoveredAt: integer('discovered_at', { mode: 'timestamp_ms' }).notNull(),
  stale: integer('stale', { mode: 'boolean' }).notNull().default(false),
})

/**
 * The last usage polling outcome of one Provider. `result` holds the last
 * successful normalized reading; `lastFailureAt` and `lastFailureMessage` are
 * kept independently so the Owner sees the latest error without losing the
 * previous successful result.
 */
export const usageSnapshots = sqliteTable('usage_snapshots', {
  providerId: text('provider_id')
    .primaryKey()
    .references(() => providers.id, { onDelete: 'cascade' }),
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
export const requestEvents = sqliteTable('request_events', {
  id: text('id').primaryKey(),
  /** Internal lifecycle; only completed rows are Owner-visible. */
  lifecycle: text('lifecycle').notNull().default('completed'),
  occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }).notNull(),
  providerId: text('provider_id')
    .notNull()
    .references(() => providers.id, { onDelete: 'cascade' }),
  providerHandle: text('provider_handle'),
  model: text('model').notNull(),
  /** Public identity of the Gateway Key the application presented. */
  gatewayKeyId: text('gateway_key_id'),
  gatewayKeyName: text('gateway_key_name'),
  /** Public identity of the Upstream Key the request actually used. */
  keyId: text('key_id'),
  /** Final HTTP status Iroha returned to the caller. */
  status: integer('status').notNull(),
  outcome: text('outcome').notNull(),
  latencyMs: integer('latency_ms').notNull(),
  isStreaming: integer('is_streaming', { mode: 'boolean' }).notNull(),
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
export const requestAttempts = sqliteTable(
  'request_attempts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    requestId: text('request_id')
      .notNull()
      .references(() => requestEvents.id, { onDelete: 'cascade' }),
    attemptNumber: integer('attempt_number').notNull(),
    /** Public identity of the Upstream Key tried on this attempt. */
    keyId: text('key_id'),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
    status: integer('status'),
    /** 'success' | 'failure' | 'skipped' (skipped when no key was eligible) */
    outcome: text('outcome').notNull(),
    errorCode: text('error_code'),
    retryAfterSeconds: integer('retry_after_seconds'),
    diagnostics: text('provider_diagnostics', { mode: 'json' }).notNull().default({}),
  },
  (table) => ({ pkRequestAttempt: primaryKey({ columns: [table.id] }) }),
)

/**
 * One background job's durable status. The scheduler writes one row per job and
 * updates it inside a database-level claim so two overlapping invocations of
 * the same job cannot both succeed. `status` is the current state (`idle`,
 * `running`, `succeeded`, `failed`); the `last_*` fields describe the most
 * recent completed run. `last_error_message` is structural text only, never
 * upstream body content that could echo a secret.
 */
export const backgroundJobs = sqliteTable('background_jobs', {
  jobId: text('job_id').primaryKey(),
  lastStartedAt: integer('last_started_at', { mode: 'timestamp_ms' }),
  lastCompletedAt: integer('last_completed_at', { mode: 'timestamp_ms' }),
  status: text('status').notNull(),
  lastOutcome: text('last_outcome'),
  lastErrorCode: text('last_error_code'),
  lastErrorMessage: text('last_error_message'),
  lastDurationMs: integer('last_duration_ms'),
  lastAffectedCount: integer('last_affected_count'),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})
