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
      await exec(
        'CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
      )
      for (const migration of applied) {
        await exec(
          `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('${migration.hash}', ${migration.when})`,
        )
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
 * Returns the tables a fresh apply of every migration up to and including
 * `baseline` must create. Used so the seeded baseline must reflect the
 * schema the migrator expects to find, even if Drizzle's `INSERT INTO` of
 * the tracking row precedes the table creation in the rolled-back case.
 */
function appliedTables(
  migrations: readonly SqlMigration[],
  baseline: number,
  dialect: 'sqlite' | 'postgres' = 'sqlite',
): readonly string[] {
  const SCHEMA_TOKEN = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+("?)(?:(public|drizzle)\.)?([A-Za-z_][\w]*)\1/i
  const tables = new Set<string>()
  for (const migration of migrations) {
    if (migration.idx > baseline) break
    for (const statement of statementsOf(migration.sql)) {
      const match = SCHEMA_TOKEN.exec(statement)
      if (match === null) continue
      const schemaPrefix = match[2] ?? ''
      const table = match[3] ?? ''
      if (table.length === 0) continue
      const qualified =
        dialect === 'postgres' && schemaPrefix.length > 0
          ? `${schemaPrefix}.${table}`
          : dialect === 'postgres'
            ? `public.${table}`
            : table
      tables.add(qualified)
    }
  }
  return [...tables]
}
