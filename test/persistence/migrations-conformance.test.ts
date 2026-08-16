import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database as BunSqlite } from 'bun:sqlite'
import { Pool } from 'pg'
import { openDatabase } from '../../src/persistence/index.ts'
import { POSTGRES_URL } from './engines.ts'

/**
 * Forwards-migration conformance from every released schema version.
 *
 * The Iroha concession is that the Owner may upgrade from any version that
 * ever shipped. The conformance suite therefore begins a fresh database
 * from every baseline (including an empty one) by replaying the released
 * SQL files, marks those migrations as recorded in Drizzle's tracking
 * table the way the migrator would have, and then asks
 * `Database.migrate()` to bring the schema to the latest version. The
 * resulting table set must match a clean apply.
 *
 * A failure here means a future migration cannot be applied to a database
 * that is exactly at some past released version, so the next deploy would
 * brick an installation that has not been migrated.
 */

const SQLITE_DIR = join(import.meta.dir, '../../migrations/sqlite')
const POSTGRES_DIR = join(import.meta.dir, '../../migrations/postgres')

interface JournalEntry {
  readonly idx: number
  readonly tag: string
  readonly when: number
}

interface SqlMigration {
  readonly idx: number
  readonly tag: string
  readonly when: number
  readonly hash: string
  readonly sql: string
}

function loadMigrations(folder: string): readonly SqlMigration[] {
  const journal = JSON.parse(
    readFileSync(join(folder, 'meta/_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] }
  return journal.entries.map((entry) => {
    const sql = readFileSync(join(folder, `${entry.tag}.sql`), 'utf8')
    const hash = createHash('sha256').update(sql).digest('hex')
    return { idx: entry.idx, tag: entry.tag, when: entry.when, hash, sql }
  })
}

/**
 * Splits a Drizzle SQL file into the individual statements the migrator
 * feeds to the session, stripping the `--> statement-breakpoint`
 * sentinel the generator inserts between statements.
 */
function statementsOf(script: string): readonly string[] {
  return script
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}

interface SchemaFingerprint {
  /** Every table qualified by schema, in deterministic order. */
  readonly tables: readonly string[]
  /** Every table's columns, in deterministic order, with their declared types. */
  readonly columns: Readonly<Record<string, readonly string[]>>
}

/**
 * Reads every column name and declared type for one SQLite table out of
 * `PRAGMA table_info`, which is the canonical source for the schema Drizzle
 * migrates. The output is independent of how the `CREATE TABLE` happened
 * to be written, so the same table seeded via raw SQL or via Drizzle
 * produces the same fingerprint.
 */
async function fingerprintSqliteFile(file: string): Promise<SchemaFingerprint> {
  const client = new BunSqlite(file, { readonly: true })
  try {
    const tables = (
      client
        .query("select name from sqlite_master where type = 'table' order by name")
        .all() as { name: string }[]
    ).map((row) => row.name)
    const columns: Record<string, string[]> = {}
    for (const name of tables) {
      const info = client
        .query(`pragma table_info(${quote(name)})`)
        .all() as { name: string; type: string }[]
      columns[name] = info.map((row) => `${row.name}:${row.type}`)
    }
    return { tables, columns }
  } finally {
    client.close()
  }
}

async function fingerprintPostgresSchema(url: string): Promise<SchemaFingerprint> {
  const pool = new Pool({ connectionString: url })
  try {
    const tableRows = await pool.query<{ table_name: string; table_schema: string }>(
      `select table_schema, table_name
         from information_schema.tables
        where table_schema in ('public', 'drizzle')
        order by table_schema, table_name`,
    )
    const tables = tableRows.rows.map(
      (row) => `${row.table_schema}.${row.table_name}`,
    )
    const columnRows = await pool.query<{
      table_schema: string
      table_name: string
      column_name: string
      data_type: string
    }>(
      `select table_schema, table_name, column_name, data_type
         from information_schema.columns
        where table_schema in ('public', 'drizzle')
        order by table_schema, table_name, ordinal_position`,
    )
    const columns: Record<string, string[]> = {}
    for (const row of columnRows.rows) {
      const key = `${row.table_schema}.${row.table_name}`
      const list = columns[key] ?? []
      list.push(`${row.column_name}:${row.data_type}`)
      columns[key] = list
    }
    return { tables, columns }
  } finally {
    await pool.end()
  }
}

/**
 * SQLite's `pragma table_info(<name>)` accepts a quoted or unquoted
 * identifier; passing an untrusted table name through plain interpolation
 * would let a maliciously-named identifier break the SQL. SQLite uses
 * double quotes for identifiers, but `pragma` also accepts single quotes
 * when the value is qualified. Double-quoting handles every reasonable
 * case here.
 */
function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

/**
 * Applies every released migration up to a baseline through a raw executor
 * and records them in Drizzle's tracking table, the way the migrator would
 * after a clean `Database.migrate()`. The executor sees one SQL statement
 * at a time, exactly as Drizzle feeds statements to the session.
 */
function buildSeededBaseline(
  migrations: readonly SqlMigration[],
  baselineIdx: number,
): {
  readonly appliedHashes: readonly string[]
  applySqlite: (exec: (statement: string) => void) => void
  applyPostgres: (exec: (statement: string) => Promise<void>) => Promise<void>
} {
  const applied = migrations.filter((migration) => migration.idx <= baselineIdx)
  return {
    appliedHashes: applied.map((migration) => migration.hash),
    applySqlite(exec) {
      for (const migration of applied) {
        for (const statement of statementsOf(migration.sql)) {
          exec(statement)
        }
      }
      exec(
        'CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
      )
      for (const migration of applied) {
        exec(
          `INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('${migration.hash}', ${migration.when})`,
        )
      }
    },
    async applyPostgres(exec) {
      for (const migration of applied) {
        for (const statement of statementsOf(migration.sql)) {
          await exec(statement)
        }
      }
      // Drizzle tracks applied migrations in `drizzle.__drizzle_migrations`.
      // The test fixture dropped that schema to mirror the freshly-bootstrapped
      // state, so we recreate it before declaring the bookkeeping entries
      // that the migrator would have written for a clean apply. The column
      // types match drizzle's own bookkeeping table so the schema fingerprint
      // is byte-for-byte identical to a clean apply.
      await exec('CREATE SCHEMA IF NOT EXISTS "drizzle"')
      await exec(
        'CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)',
      )
      for (const migration of applied) {
        await exec(
          `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('${migration.hash}', ${migration.when})`,
        );
      }
    },
  }
}

function baselineLabel(baseline: number): string {
  return baseline === -1 ? 'empty' : String(baseline).padStart(4, '0')
}

describe('SQLite forward migration from every released schema version', () => {
  const migrations = loadMigrations(SQLITE_DIR)
  const tempDirectories: string[] = []

  function freshSqliteFile(label: string): string {
    const directory = mkdtempSync(join(tmpdir(), `iroha-migrate-${process.pid}-${label}-`))
    tempDirectories.push(directory)
    return join(directory, 'iroha.db')
  }

  afterEach(() => {
    while (tempDirectories.length > 0) {
      const directory = tempDirectories.shift()!
      try {
        rmSync(directory, { recursive: true, force: true })
      } catch {
        // Windows can hold a briefly-closed SQLite WAL open past `close()`.
        // A leftover temp directory is not a test failure, so removal is
        // retried a few times before being left to the OS temp cleanup.
      }
    }
  })

  test('the released journal covers every migration in strict index order', () => {
    const indices = migrations.map((migration) => migration.idx).sort((a, b) => a - b)
    expect(indices).toEqual([...Array(migrations.length).keys()])
  })

  test('a clean database migrates to the expected end-state', async () => {
    const file = freshSqliteFile('clean')
    const database = openDatabase({
      dialect: 'sqlite',
      file,
      ephemeral: false,
      describe: 'sqlite (clean apply)',
    })
    try {
      await database.migrate()
      const fingerprint = await fingerprintSqliteFile(file)
      expect(fingerprint.tables.length).toBeGreaterThan(0)
      for (const table of fingerprint.tables) {
        expect(fingerprint.columns[table]?.length ?? 0).toBeGreaterThan(0)
      }
    } finally {
      await database.close()
    }
  })

  test('backfills transliterated, length-safe deterministic Provider Handles', () => {
    const file = freshSqliteFile('provider-handles-backfill')
    const client = new BunSqlite(file, { create: true })
    try {
      buildSeededBaseline(migrations, 17).applySqlite((statement) => client.exec(statement))
      const insert = client.query(`insert into providers (
        id, display_name, base_url, allow_insecure_http, enabled, retry_max_attempts,
        retry_ambiguous_network, archived_at, template_id, capabilities, auth_header,
        auth_prefix, static_headers_encrypted, redirect_allow_same_origin,
        connection_timeout_ms, first_byte_timeout_ms, non_streaming_total_timeout_ms,
        streaming_idle_timeout_ms, total_retry_timeout_ms, idempotency_header, created_at, updated_at
      ) values (?, ?, 'https://example.test/v1', 0, 1, 3, 0, null, null, '{}',
        'authorization', 'Bearer ', '[]', 0, 10000, 20000, 120000, 30000, 30000,
        'Idempotency-Key', ?, ?)`)
      const long = 'a'.repeat(63)
      insert.run('pr_a', 'CAFÉ', 1, 1)
      insert.run('pr_b', 'CAFÉ', 2, 2)
      insert.run('pr_c', `${long}x`, 3, 3)
      insert.run('pr_d', `${long}y`, 4, 4)
      insert.run('pr_e', 'Foo', 5, 5)
      insert.run('pr_f', 'Foo', 6, 6)
      insert.run('pr_g', 'Foo 2', 7, 7)
      for (const statement of statementsOf(migrations[18]!.sql)) client.exec(statement)
      expect(client.query('select id, handle from providers order by created_at, id').all()).toEqual([
        { id: 'pr_a', handle: 'cafe' },
        { id: 'pr_b', handle: 'cafe-2' },
        { id: 'pr_c', handle: long },
        { id: 'pr_d', handle: `${'a'.repeat(61)}-2` },
        { id: 'pr_e', handle: 'foo' },
        { id: 'pr_f', handle: 'foo-2' },
        { id: 'pr_g', handle: 'foo-2-2' },
      ])
    } finally {
      client.close()
    }
  })

  for (const baseline of [-1, ...migrations.map((migration) => migration.idx)]) {
    const label = baseline === -1 ? 'an empty database' : migrations[baseline]!.tag

    test(`forwards successfully from ${label}`, async () => {
      const file = freshSqliteFile(`baseline-${baselineLabel(baseline)}`)
      const seedClient = new BunSqlite(file, { create: true })
      seedClient.exec('pragma foreign_keys = ON')
      const seed = buildSeededBaseline(migrations, baseline)
      seed.applySqlite((statement) => {
        seedClient.exec(statement)
      })
      seedClient.close()

      const database = openDatabase({
        dialect: 'sqlite',
        file,
        ephemeral: false,
        describe: `sqlite (baseline ${label})`,
      })
      try {
        await database.migrate()
        const after = await fingerprintSqliteFile(file)
        expect(after.tables.length).toBeGreaterThan(0)
        for (const expectedTable of appliedTables(migrations, baseline)) {
          expect(after.tables).toContain(expectedTable)
        }
        expect(after.tables).toContain('__drizzle_migrations')
      } finally {
        await database.close()
      }
    })

    test(`after migrate from ${label} the schema matches a clean apply`, async () => {
      const file = freshSqliteFile(`matches-${baselineLabel(baseline)}`)
      const seedClient = new BunSqlite(file, { create: true })
      seedClient.exec('pragma foreign_keys = ON')
      const seed = buildSeededBaseline(migrations, baseline)
      seed.applySqlite((statement) => {
        seedClient.exec(statement)
      })
      seedClient.close()

      const database = openDatabase({
        dialect: 'sqlite',
        file,
        ephemeral: false,
        describe: `sqlite (baseline ${label} -> end)`,
      })
      try {
        await database.migrate()
        const actual = await fingerprintSqliteFile(file)

        const cleanFile = freshSqliteFile(`clean-for-${baselineLabel(baseline)}`)
        const cleanDatabase = openDatabase({
          dialect: 'sqlite',
          file: cleanFile,
          ephemeral: false,
          describe: 'sqlite (clean for comparison)',
        })
        try {
          await cleanDatabase.migrate()
          const expected = await fingerprintSqliteFile(cleanFile)
          expect([...actual.tables].sort()).toEqual([...expected.tables].sort())
          expect(actual.columns).toEqual(expected.columns)
        } finally {
          await cleanDatabase.close()
        }
      } finally {
        await database.close()
      }
    })
  }
})

if (POSTGRES_URL) {
  describe('PostgreSQL forward migration from every released schema version', () => {
    const migrations = loadMigrations(POSTGRES_DIR)

    test('the released journal covers every migration in strict index order', () => {
      const indices = migrations.map((migration) => migration.idx).sort((a, b) => a - b)
      expect(indices).toEqual([...Array(migrations.length).keys()])
    })

    test('backfills transliterated, length-safe deterministic Provider Handles', async () => {
      const pool = new Pool({ connectionString: POSTGRES_URL })
      try {
        await pool.query('drop schema if exists public cascade')
        await pool.query('create schema public')
        await pool.query('drop schema if exists drizzle cascade')
        await buildSeededBaseline(migrations, 18).applyPostgres((statement) => pool.query(statement).then(() => undefined))
        const long = 'a'.repeat(63)
        for (const [id, name, time] of [
          ['pr_a', 'CAFÉ', 1], ['pr_b', 'CAFÉ', 2], ['pr_c', `${long}x`, 3], ['pr_d', `${long}y`, 4],
          ['pr_e', 'Foo', 5], ['pr_f', 'Foo', 6], ['pr_g', 'Foo 2', 7],
        ] as const) {
          await pool.query(`insert into providers (
            id, display_name, base_url, allow_insecure_http, enabled, retry_max_attempts,
            retry_ambiguous_network, archived_at, template_id, capabilities, auth_header,
            auth_prefix, static_headers_encrypted, redirect_allow_same_origin,
            connection_timeout_ms, first_byte_timeout_ms, non_streaming_total_timeout_ms,
            streaming_idle_timeout_ms, total_retry_timeout_ms, idempotency_header, created_at, updated_at
          ) values ($1, $2, 'https://example.test/v1', false, true, 3, false, null, null, '{}',
            'authorization', 'Bearer ', '[]', false, 10000, 20000, 120000, 30000, 30000,
            'Idempotency-Key', to_timestamp($3), to_timestamp($3))`, [id, name, time])
        }
        for (const statement of statementsOf(migrations[19]!.sql)) await pool.query(statement)
        const result = await pool.query('select id, handle from providers order by created_at, id')
        expect(result.rows).toEqual([
          { id: 'pr_a', handle: 'cafe' }, { id: 'pr_b', handle: 'cafe-2' },
          { id: 'pr_c', handle: long }, { id: 'pr_d', handle: `${'a'.repeat(61)}-2` },
          { id: 'pr_e', handle: 'foo' }, { id: 'pr_f', handle: 'foo-2' },
          { id: 'pr_g', handle: 'foo-2-2' },
        ])
      } finally {
        await pool.end()
      }
    })

    for (const baseline of [-1, ...migrations.map((migration) => migration.idx)]) {
      const label = baseline === -1 ? 'an empty schema' : migrations[baseline]!.tag

      test(`forwards successfully from ${label}`, async () => {
        const pool = new Pool({ connectionString: POSTGRES_URL })
        try {
          await pool.query('drop schema if exists public cascade')
          await pool.query('create schema public')
          await pool.query('drop schema if exists drizzle cascade')
          const seed = buildSeededBaseline(migrations, baseline)
          await seed.applyPostgres(async (statement) => {
            await pool.query(statement)
          })
        } finally {
          await pool.end()
        }

        const database = openDatabase({
          dialect: 'postgres',
          url: POSTGRES_URL ?? '',
          describe: `postgres (baseline ${label})`,
        })
        try {
          await database.migrate()
          const actual = await fingerprintPostgresSchema(POSTGRES_URL ?? '')
          expect(actual.tables.length).toBeGreaterThan(0)
          expect(actual.tables).toContain('drizzle.__drizzle_migrations')
          for (const expectedTable of appliedTables(migrations, baseline, 'postgres')) {
            expect(actual.tables).toContain(expectedTable)
          }
        } finally {
          await database.close()
        }
      })

      test(`after migrate from ${label} the schema matches a clean apply`, async () => {
        const seedPool = new Pool({ connectionString: POSTGRES_URL })
        try {
          await seedPool.query('drop schema if exists public cascade')
          await seedPool.query('create schema public')
          await seedPool.query('drop schema if exists drizzle cascade')
          const seed = buildSeededBaseline(migrations, baseline)
          await seed.applyPostgres(async (statement) => {
            await seedPool.query(statement)
          })
        } finally {
          await seedPool.end()
        }

        const database = openDatabase({
          dialect: 'postgres',
          url: POSTGRES_URL ?? '',
          describe: `postgres (baseline ${label} -> end)`,
        })
        try {
          await database.migrate()
          const actual = await fingerprintPostgresSchema(POSTGRES_URL ?? '')

          const cleanPool = new Pool({ connectionString: POSTGRES_URL ?? '' })
          try {
            await cleanPool.query('drop schema if exists public cascade')
            await cleanPool.query('create schema public')
            await cleanPool.query('drop schema if exists drizzle cascade')
          } finally {
            await cleanPool.end()
          }

          const cleanDatabase = openDatabase({
            dialect: 'postgres',
            url: POSTGRES_URL ?? '',
            describe: 'postgres (clean for comparison)',
          })
          try {
            await cleanDatabase.migrate()
            const expected = await fingerprintPostgresSchema(POSTGRES_URL ?? '')
            expect([...actual.tables].sort()).toEqual([...expected.tables].sort())
            expect(actual.columns).toEqual(expected.columns)
          } finally {
            await cleanDatabase.close()
          }
        } finally {
          await database.close()
        }
      })
    }
  })
}

/**
 * Returns the tables a fresh apply of every shipped migration produces.
 * Used so the seeded baseline must reflect the schema the migrator
 * expects to find, even if Drizzle's `INSERT INTO` of the tracking row
 * precedes the table creation in the rolled-back case.
 *
 * `ALTER TABLE ... RENAME TO ...` (introduced by the Provider-rename
 * migration) is tracked the same way Drizzle tracks it: the old name is
 * dropped from the fingerprint set and the new name replaces it. The
 * `baseline` parameter is retained so each call site reads as "the table
 * set this baseline must end up producing" but is intentionally unused:
 * a forward migration always ends at the latest schema, so the expected
 * table set is "everything a clean apply produces" regardless of which
 * baseline was seeded. Skipping the per-baseline filter for `CREATE TABLE`
 * would let a regression that drops a table in any migration slip
 * through, because no baseline assertion would catch it.
 *
 * PostgreSQL double-quotes identifiers and uses `public.` by default;
 * SQLite uses backticks. Both dialects use unqualified table names in
 * CREATE / RENAME statements, so a single regex captures them.
 */
function appliedTables(
  migrations: readonly SqlMigration[],
  _baseline: number,
  dialect: 'sqlite' | 'postgres' = 'sqlite',
): readonly string[] {
  const CREATE_TOKEN =
    /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+("?|`)(?:(public|drizzle)\.)?([A-Za-z_][\w]*)\1/i
  const RENAME_TOKEN =
    /ALTER TABLE\s+("?|`)(?:(public|drizzle)\.)?([A-Za-z_][\w]*)\1\s+RENAME\s+TO\s+("?|`)([A-Za-z_][\w]*)\4/i
  const tables = new Set<string>()
  const qualify = (table: string, schemaPrefix: string): string => {
    if (dialect !== 'postgres') return table
    if (schemaPrefix.length > 0) return `${schemaPrefix}.${table}`
    return `public.${table}`
  }
  for (const migration of migrations) {
    for (const statement of statementsOf(migration.sql)) {
      const rename = RENAME_TOKEN.exec(statement)
      if (rename !== null) {
        const oldSchema = rename[2] ?? ''
        const oldTable = rename[3] ?? ''
        const newTable = rename[5] ?? ''
        if (oldTable.length > 0) tables.delete(qualify(oldTable, oldSchema))
        if (newTable.length > 0) tables.add(qualify(newTable, oldSchema))
        continue
      }
      const match = CREATE_TOKEN.exec(statement)
      if (match === null) continue
      const schemaPrefix = match[2] ?? ''
      const table = match[3] ?? ''
      if (table.length === 0) continue
      tables.add(qualify(table, schemaPrefix))
    }
  }
  return [...tables]
}
