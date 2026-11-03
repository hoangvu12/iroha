/**
 * Copies the core Gateway data from the configured PostgreSQL database into
 * a fresh SQLite file, applying the SQLite migrations first. Request history,
 * audit events, background job state, and Owner sessions are deliberately
 * not copied: they are operational records, not Gateway configuration.
 *
 * The source database comes from `DATABASE_URL` in the environment (or the
 * local `.env`), so the Postgres URL in `.env` selects the source. The target
 * is a SQLite path given with `--to` (default `data/iroha.db`).
 *
 * Usage:
 *   bun run scripts/pg-to-sqlite.ts [--to data/iroha.db] [--force]
 *
 * `--force` deletes an existing target file first; without it an existing
 * file is refused so a re-run can never silently merge into old data.
 */
import { Database as BunSqlite } from 'bun:sqlite'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import pg from 'pg'
import { loadConfiguration } from '../src/config/environment.ts'

const MIGRATIONS_FOLDER = join(import.meta.dir, '../migrations/sqlite')

const args = process.argv.slice(2)
const force = args.includes('--force')
const toIndex = args.indexOf('--to')
const target = toIndex >= 0 ? args[toIndex + 1] : 'data/iroha.db'

/** How one PostgreSQL column's value is written into SQLite. */
type Kind = 'plain' | 'ts' | 'bool' | 'json'

type TableSpec = {
  table: string
  columns: [string, Kind][]
}

/**
 * Copy order follows the foreign keys: providers before their keys and
 * catalogs, upstream_accounts before the keys referencing them.
 */
const TABLES: TableSpec[] = [
  {
    table: 'settings',
    columns: [
      ['key', 'plain'],
      ['value', 'json'],
      ['updated_at', 'ts'],
    ],
  },
  {
    table: 'owner',
    columns: [
      ['id', 'plain'],
      ['username', 'plain'],
      ['password_hash', 'plain'],
      ['created_at', 'ts'],
      ['password_changed_at', 'ts'],
    ],
  },
  {
    table: 'providers',
    columns: [
      ['id', 'plain'],
      ['handle', 'plain'],
      ['display_name', 'plain'],
      ['base_url', 'plain'],
      ['logo_domain', 'plain'],
      ['allow_insecure_http', 'bool'],
      ['enabled', 'bool'],
      ['retry_max_attempts', 'plain'],
      ['retry_ambiguous_network', 'bool'],
      ['archived_at', 'ts'],
      ['template_id', 'plain'],
      ['capabilities', 'json'],
      ['auth_header', 'plain'],
      ['auth_prefix', 'plain'],
      ['static_headers_encrypted', 'plain'],
      ['redirect_allow_same_origin', 'bool'],
      ['connection_timeout_ms', 'plain'],
      ['first_byte_timeout_ms', 'plain'],
      ['non_streaming_total_timeout_ms', 'plain'],
      ['streaming_idle_timeout_ms', 'plain'],
      ['total_retry_timeout_ms', 'plain'],
      ['idempotency_header', 'plain'],
      ['created_at', 'ts'],
      ['updated_at', 'ts'],
    ],
  },
  {
    table: 'upstream_accounts',
    columns: [
      ['id', 'plain'],
      ['provider_id', 'plain'],
      ['display_name', 'plain'],
      ['created_at', 'ts'],
      ['updated_at', 'ts'],
    ],
  },
  {
    table: 'upstream_keys',
    columns: [
      ['id', 'plain'],
      ['provider_id', 'plain'],
      ['base_url', 'plain'],
      ['account_id', 'plain'],
      ['encrypted_key', 'plain'],
      ['health', 'plain'],
      ['last_probe_at', 'ts'],
      ['last_probe_verdict', 'plain'],
      ['last_probe_reason', 'plain'],
      ['health_reason', 'plain'],
      ['health_changed_at', 'ts'],
      ['retry_after_at', 'ts'],
      ['health_scope', 'plain'],
      ['health_scope_id', 'plain'],
      ['health_model', 'plain'],
      ['allowed_models', 'json'],
      ['denied_models', 'json'],
      ['created_at', 'ts'],
      ['updated_at', 'ts'],
    ],
  },
  {
    table: 'gateway_keys',
    columns: [
      ['id', 'plain'],
      ['name', 'plain'],
      ['secret_hash', 'plain'],
      ['scope', 'json'],
      ['access_mode', 'plain'],
      ['revision', 'plain'],
      ['cors_origins', 'json'],
      ['created_at', 'ts'],
      ['last_used_at', 'ts'],
      ['revoked_at', 'ts'],
    ],
  },
  {
    table: 'model_catalog_entries',
    columns: [
      ['provider_id', 'plain'],
      ['model_id', 'plain'],
      ['source', 'plain'],
      ['excluded', 'bool'],
      ['overrides', 'json'],
      ['metadata', 'json'],
      ['created_at', 'ts'],
      ['updated_at', 'ts'],
    ],
  },
  {
    table: 'model_catalog_sync',
    columns: [
      ['provider_id', 'plain'],
      ['synced_at', 'ts'],
      ['last_success_at', 'ts'],
      ['last_failure_at', 'ts'],
      ['last_failure_message', 'plain'],
    ],
  },
  {
    table: 'key_model_availability',
    columns: [
      ['key_id', 'plain'],
      ['provider_id', 'plain'],
      ['models', 'json'],
      ['discovered_at', 'ts'],
      ['stale', 'bool'],
    ],
  },
  {
    table: 'usage_snapshots',
    columns: [
      ['provider_id', 'plain'],
      ['visibility', 'plain'],
      ['synced_at', 'ts'],
      ['last_success_at', 'ts'],
      ['last_failure_at', 'ts'],
      ['last_failure_code', 'plain'],
      ['last_failure_message', 'plain'],
      ['result', 'json'],
    ],
  },
]

function convert(value: unknown, kind: Kind): string | number | null {
  if (value === null || value === undefined) return null
  switch (kind) {
    case 'ts':
      return value instanceof Date ? value.getTime() : new Date(value as string).getTime()
    case 'bool':
      return value ? 1 : 0
    case 'json':
      return JSON.stringify(value)
    default:
      return value as string | number
  }
}

const config = loadConfiguration()
if (config.database.dialect !== 'postgres') {
  console.error('DATABASE_URL must select the PostgreSQL source database.')
  process.exit(1)
}

if (existsSync(target)) {
  if (!force) {
    console.error(`${target} already exists; pass --force to replace it.`)
    process.exit(1)
  }
  rmSync(target)
  rmSync(`${target}-wal`)
  rmSync(`${target}-shm`)
}
mkdirSync(dirname(target) || '.', { recursive: true })

const source = new pg.Client({ connectionString: config.database.url })
await source.connect()

const sqlite = new BunSqlite(target, { create: true })
sqlite.exec('pragma journal_mode = WAL')
sqlite.exec('pragma foreign_keys = ON')
sqlite.exec('pragma busy_timeout = 5000')

migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER })

sqlite.exec('begin immediate')
try {
  for (const spec of TABLES) {
    const { rows } = await source.query(`select * from ${spec.table}`)
    const names = spec.columns.map(([name]) => `"${name}"`).join(', ')
    const placeholders = spec.columns.map(() => '?').join(', ')
    const insert = sqlite.prepare(`insert into "${spec.table}" (${names}) values (${placeholders})`)
    for (const row of rows) {
      insert.run(...spec.columns.map(([name, kind]) => convert(row[name], kind)))
    }
    console.log(`${spec.table}: ${rows.length} rows copied`)
  }
  sqlite.exec('commit')
} catch (error) {
  sqlite.exec('rollback')
  throw error
} finally {
  sqlite.close()
  await source.end()
}

console.log(`\nWrote ${target}`)
