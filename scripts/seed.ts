/**
 * One-shot sample data seeder. Wires the running Iroha deployment to a realistic
 * Owner view so the UI has something to draw: three Provider Connections, a mix
 * of healthy / cooling-down / exhausted / disabled Upstream Keys, a Gateway Key,
 * twelve weeks of request history with business-hour peaks, and a sprinkling of
 * audit events.
 *
 * Idempotent: fixed primary keys, so a second run replaces the same rows instead
 * of duplicating them.
 *
 * Usage:
 *   `bun run scripts/seed.ts`         seed (or refresh) the sample data
 *   `bun run scripts/seed.ts --wipe`  delete only the seeded rows, leave the rest
 */
import { createHash, createCipheriv, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'

const envFile = resolve(process.cwd(), '.env')
const envLines = readFileSync(envFile, 'utf8').split(/\r?\n/)
for (const line of envLines) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  const eq = trimmed.indexOf('=')
  if (eq < 0) continue
  const key = trimmed.slice(0, eq).trim()
  const value = trimmed.slice(eq + 1).trim()
  if (!(key in process.env)) process.env[key] = value
}

const DATABASE_URL = process.env.DATABASE_URL
const MASTER_KEY = process.env.IROHA_MASTER_KEY
if (!DATABASE_URL) throw new Error('DATABASE_URL missing from .env')
if (!MASTER_KEY) throw new Error('IROHA_MASTER_KEY missing from .env')

const WIPE_ONLY = process.argv.includes('--wipe')

function encryptSecret(plaintext: string): string {
  const key = createHash('sha256').update(MASTER_KEY, 'utf8').digest()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const payload = Buffer.concat([cipher.getAuthTag(), encrypted])
  return `v1.${iv.toString('base64url')}.${payload.toString('base64url')}`
}

function hashSecret(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex')
}

function id(short: string): string {
  return `seed-${short}`
}

const NOW = new Date()
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

interface ConnectionSpec {
  readonly id: string
  readonly displayName: string
  readonly baseUrl: string
  readonly model: string
}

const CONNECTIONS: readonly ConnectionSpec[] = [
  { id: 'openai', displayName: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { id: 'anthropic', displayName: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-20241022' },
  { id: 'mistral', displayName: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-large-latest' },
] as const

interface KeySpec {
  readonly id: string
  readonly connectionId: string
  readonly health: 'active' | 'cooling_down' | 'exhausted' | 'disabled' | 'unverified' | 'invalid_authentication'
  readonly reason: string | null
  readonly retryAfterMinutes?: number
}

const KEYS: readonly KeySpec[] = [
  { id: 'openai-1', connectionId: 'openai', health: 'active', reason: null },
  { id: 'openai-2', connectionId: 'openai', health: 'active', reason: null },
  { id: 'openai-3', connectionId: 'openai', health: 'cooling_down', reason: 'Rate limit reached', retryAfterMinutes: 12 },
  { id: 'anthropic-1', connectionId: 'anthropic', health: 'active', reason: null },
  { id: 'anthropic-2', connectionId: 'anthropic', health: 'exhausted', reason: 'Quota exceeded' },
  { id: 'mistral-1', connectionId: 'mistral', health: 'disabled', reason: 'Disabled by Owner' },
] as const

const GATEWAY_KEY_ID = 'demo-app'
const GATEWAY_KEY_SECRET = 'demo-secret-do-not-use-in-production-0123456789'

interface RequestEventRow {
  readonly id: string
  readonly occurredAt: Date
  readonly connectionId: string
  readonly model: string
  readonly gatewayKeyId: string
  readonly keyId: string
  readonly status: number
  readonly outcome: 'success' | 'failure'
  readonly latencyMs: number
  readonly isStreaming: boolean
  readonly promptTokens: number | null
  readonly completionTokens: number | null
  readonly totalTokens: number | null
  readonly errorCode: string | null
}

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!
}

function buildRequestEvents(): RequestEventRow[] {
  const rows: RequestEventRow[] = []
  // Reserve a chunk for the last 12 hours so the Overview's hourly buckets
  // are visibly populated, then fill the rest with a recency-biased spread
  // over 26 weeks so the heatmap shows rhythm.
  const recentCount = 90
  const historicalCount = 320
  for (let i = 0; i < recentCount; i++) {
    const minutesAgo = Math.floor(Math.random() * 12 * 60)
    const base = new Date(NOW.getTime() - minutesAgo * 60 * 1000)
    rows.push(makeRow(base, `req-recent-${i}`))
  }
  for (let i = 0; i < historicalCount; i++) {
    // Math.random() * Math.random() biases heavily toward small values, with a
    // long tail so the oldest weeks still get a sprinkling of events.
    const daysAgo = Math.floor(Math.pow(Math.random(), 1.4) * 26 * 7)
    const base = new Date(NOW.getTime() - daysAgo * DAY - Math.floor(Math.random() * 24) * HOUR)
    rows.push(makeRow(base, `req-hist-${daysAgo}-${i}`))
  }
  return rows.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
}

function makeRow(base: Date, rowId: string): RequestEventRow {
  const hour = (() => {
    const dow = base.getDay()
    const isWeekend = dow === 0 || dow === 6
    if (isWeekend) return Math.floor(Math.random() * 24)
    const r = Math.random()
    if (r < 0.55) return 9 + Math.floor(Math.random() * 10)
    if (r < 0.8) return 18 + Math.floor(Math.random() * 8)
    return Math.floor(Math.random() * 9)
  })()
  base.setHours(hour, Math.floor(Math.random() * 60), Math.floor(Math.random() * 60), 0)

  const conn = pick(CONNECTIONS)
  const model = conn.model
  const eligibleKeys = KEYS.filter((k) => k.connectionId === conn.id && k.health === 'active')
  const key = eligibleKeys.length > 0 ? pick(eligibleKeys) : KEYS.find((k) => k.connectionId === conn.id)
  if (!key) {
    throw new Error(`No key for connection ${conn.id}; seed spec is malformed`)
  }

  const status = (() => {
    const r = Math.random()
    if (r < 0.84) return 200
    if (r < 0.92) return 429
    if (r < 0.96) return 500
    return 503
  })()
  const isFailure = status >= 400
  const baseLatency = model.startsWith('gpt-4o') ? 900 : model.startsWith('claude') ? 1300 : 700
  const latencyMs = Math.round(baseLatency + (Math.random() - 0.5) * baseLatency * 0.9 + Math.random() * 200)
  const isStreaming = Math.random() < 0.4
  const promptTokens = status === 200 || status === 429 ? Math.round(200 + Math.random() * 1500) : null
  const completionTokens = status === 200 ? Math.round(50 + Math.random() * 800) : null
  const totalTokens =
    promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null
  const errorCode = isFailure
    ? status === 429
      ? 'rate_limited'
      : status === 500
        ? 'upstream_error'
        : 'service_unavailable'
    : null

  return {
    id: rowId,
    occurredAt: base,
    connectionId: conn.id,
    model,
    gatewayKeyId: GATEWAY_KEY_ID,
    keyId: key.id,
    status,
    outcome: isFailure ? 'failure' : 'success',
    latencyMs,
    isStreaming,
    promptTokens,
    completionTokens,
    totalTokens,
    errorCode,
  }
}

interface AuditEventRow {
  readonly occurredAt: Date
  readonly action: string
  readonly outcome: 'success' | 'failure'
  readonly detail: Record<string, unknown>
}

function buildAuditEvents(): AuditEventRow[] {
  const events: AuditEventRow[] = [
    {
      occurredAt: new Date(NOW.getTime() - 1 * DAY),
      action: 'connection.created',
      outcome: 'success',
      detail: { id: 'openai', displayName: 'OpenAI' },
    },
    {
      occurredAt: new Date(NOW.getTime() - 1 * DAY - 30 * 60 * 1000),
      action: 'key.added',
      outcome: 'success',
      detail: { connectionId: 'openai', keyId: 'openai-1' },
    },
    {
      occurredAt: new Date(NOW.getTime() - 1 * DAY - 60 * 60 * 1000),
      action: 'key.tested',
      outcome: 'success',
      detail: { connectionId: 'openai', keyId: 'openai-1', verdict: 'usable' },
    },
    {
      occurredAt: new Date(NOW.getTime() - 12 * HOUR),
      action: 'connection.created',
      outcome: 'success',
      detail: { id: 'anthropic', displayName: 'Anthropic' },
    },
    {
      occurredAt: new Date(NOW.getTime() - 6 * HOUR),
      action: 'key.health_changed',
      outcome: 'success',
      detail: { connectionId: 'openai', keyId: 'openai-3', from: 'active', to: 'cooling_down' },
    },
    {
      occurredAt: new Date(NOW.getTime() - 4 * HOUR),
      action: 'connection.created',
      outcome: 'success',
      detail: { id: 'mistral', displayName: 'Mistral' },
    },
    {
      occurredAt: new Date(NOW.getTime() - 2 * HOUR),
      action: 'key.disabled',
      outcome: 'success',
      detail: { connectionId: 'mistral', keyId: 'mistral-1' },
    },
    {
      occurredAt: new Date(NOW.getTime() - 90 * 60 * 1000),
      action: 'gateway_key.created',
      outcome: 'success',
      detail: { id: GATEWAY_KEY_ID, name: 'Demo application' },
    },
    {
      occurredAt: new Date(NOW.getTime() - 45 * 60 * 1000),
      action: 'settings.request_history.updated',
      outcome: 'success',
      detail: { days: 30 },
    },
  ]
  return events
}

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL })
  await client.connect()
  try {
    await client.query('BEGIN')

    // Wipe seeded data only — leave Owner / settings / sessions untouched.
    await client.query(`DELETE FROM request_events WHERE id LIKE 'req-%'`)
    await client.query(`DELETE FROM audit_events WHERE detail->>'id' IN ('openai','anthropic','mistral','demo-app')`)
    await client.query(`DELETE FROM upstream_keys WHERE id LIKE $1`, ['seed-%'])
    await client.query(`DELETE FROM provider_connections WHERE id LIKE $1`, ['seed-%'])
    await client.query(`DELETE FROM gateway_keys WHERE id = $1`, [GATEWAY_KEY_ID])

    if (WIPE_ONLY) {
      await client.query('COMMIT')
      console.log('Wiped seeded data.')
      return
    }

    // Provider connections.
    for (const conn of CONNECTIONS) {
      await client.query(
        `INSERT INTO provider_connections
          (id, display_name, base_url, allow_insecure_http, enabled,
           retry_max_attempts, retry_ambiguous_network, archived_at, template_id,
           capabilities, auth_header, auth_prefix, static_headers_encrypted,
           redirect_allow_same_origin, connection_timeout_ms, first_byte_timeout_ms,
           non_streaming_total_timeout_ms, streaming_idle_timeout_ms,
           total_retry_timeout_ms, idempotency_header, created_at, updated_at)
         VALUES ($1,$2,$3,false,true,3,false,NULL,NULL,
                 $4::jsonb,'authorization','Bearer ','[]',false,
                 10000,20000,120000,30000,30000,'Idempotency-Key',
                 NOW(),NOW())`,
        [
          id(conn.id),
          conn.displayName,
          conn.baseUrl,
          JSON.stringify({ chat: true, streaming: true, tools: true, structuredOutput: true, responses: true }),
        ],
      )
    }

    // Upstream keys.
    for (const key of KEYS) {
      const encryptedKey = encryptSecret(`sk-${key.id}-not-a-real-key-000000000000000000`)
      const retryAfterAt = key.retryAfterMinutes !== undefined
        ? new Date(NOW.getTime() + key.retryAfterMinutes * 60 * 1000)
        : null
      await client.query(
        `INSERT INTO upstream_keys
          (id, connection_id, account_id, encrypted_key, health,
           last_probe_at, last_probe_verdict, last_probe_reason,
           health_reason, health_changed_at, retry_after_at,
           health_scope, health_scope_id, health_model,
           allowed_models, denied_models, created_at, updated_at)
         VALUES ($1,$2,NULL,$3,$4,NOW(),'usable',NULL,$5,NOW(),$6,'key',NULL,NULL,NULL,NULL,NOW(),NOW())`,
        [
          id(key.id),
          id(key.connectionId),
          encryptedKey,
          key.health,
          key.reason,
          retryAfterAt,
        ],
      )
    }

    // Gateway key.
    await client.query(
      `INSERT INTO gateway_keys
        (id, name, secret_hash, scope, cors_origins, created_at, last_used_at, revoked_at)
       VALUES ($1,$2,$3,$4::jsonb,'[]'::jsonb,NOW(),NULL,NULL)`,
      [
        GATEWAY_KEY_ID,
        'Demo application',
        hashSecret(GATEWAY_KEY_SECRET),
        JSON.stringify([
          { connectionId: id('openai'), models: null },
          { connectionId: id('anthropic'), models: null },
          { connectionId: id('mistral'), models: null },
        ]),
      ],
    )

    // Request events.
    const events = buildRequestEvents()
    for (const event of events) {
      await client.query(
        `INSERT INTO request_events
          (id, occurred_at, connection_id, model, gateway_key_id, key_id,
           status, outcome, latency_ms, is_streaming,
           prompt_tokens, completion_tokens, total_tokens, error_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          event.id,
          event.occurredAt,
          id(event.connectionId),
          event.model,
          event.gatewayKeyId,
          id(event.keyId),
          event.status,
          event.outcome,
          event.latencyMs,
          event.isStreaming,
          event.promptTokens,
          event.completionTokens,
          event.totalTokens,
          event.errorCode,
        ],
      )
    }

    // Audit events.
    const audits = buildAuditEvents()
    for (const audit of audits) {
      await client.query(
        `INSERT INTO audit_events (occurred_at, action, outcome, detail)
         VALUES ($1,$2,$3,$4::jsonb)`,
        [audit.occurredAt, audit.action, audit.outcome, JSON.stringify(audit.detail)],
      )
    }

    await client.query('COMMIT')

    console.log(`Seeded ${CONNECTIONS.length} connections, ${KEYS.length} keys, 1 gateway key, ${events.length} request events, ${audits.length} audit events.`)
    console.log(`Demo Gateway Key: id=${GATEWAY_KEY_ID} secret=${GATEWAY_KEY_SECRET}`)
    console.log('Run `bun run scripts/seed.ts --wipe` to remove this sample data.')
  } catch (cause) {
    await client.query('ROLLBACK')
    throw cause
  } finally {
    await client.end()
  }
}

await main()