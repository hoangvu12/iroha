import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseConfiguration } from '../../src/config/environment.ts'
import { openDatabase, type Database } from '../../src/persistence/index.ts'

/**
 * The engines the repository contract is proven against.
 *
 * SQLite always runs. PostgreSQL runs when `IROHA_TEST_POSTGRES_URL` names a
 * reachable database that the suite may create and drop tables in; without it
 * the PostgreSQL cases are skipped rather than silently reported as passing.
 *
 * ⚠️  `IROHA_TEST_POSTGRES_URL` must point at a *disposable* database. The
 * postgres engine's `open()` drops the entire `public` schema on every
 * `beforeEach` (`resetPostgresSchema` below). Pointing it at a live database
 * will wipe every row in `public.*` and require a fresh setup. Spin up a
 * throwaway neon branch, a local docker-compose postgres, or any other
 * instance you can re-create in one command.
 */
export interface TestEngine {
  readonly name: 'sqlite' | 'postgres'
  /** Opens a migrated database isolated from every other test. */
  open(): Promise<{ database: Database; dispose: () => Promise<void> }>
}

export const POSTGRES_URL = Bun.env.IROHA_TEST_POSTGRES_URL

if (POSTGRES_URL && !POSTGRES_URL.includes('test') && !POSTGRES_URL.includes('disposable')) {
  // Cheap safety net: a URL that doesn't even mention "test" or "disposable"
  // almost certainly points at a live database. The schema drop will destroy
  // data. Bail loudly so a developer notices before running the suite.
  console.warn(
    '[iroha] IROHA_TEST_POSTGRES_URL does not look like a disposable database ' +
      '(no "test" or "disposable" in the host). The conformance suite will ' +
      '`drop schema public cascade` on every beforeEach. If this is a live ' +
      'database, unset the variable and run sqlite-only.',
  )
}

export const sqliteEngine: TestEngine = {
  name: 'sqlite',
  async open() {
    const directory = mkdtempSync(join(tmpdir(), 'iroha-sqlite-'))
    const config: DatabaseConfiguration = {
      dialect: 'sqlite',
      file: join(directory, 'iroha.db'),
      ephemeral: false,
      describe: 'sqlite (test)',
    }

    const database = openDatabase(config)
    await database.migrate()

    return {
      database,
      dispose: async () => {
        await database.close()
        await removeEventually(directory)
      },
    }
  },
}

/**
 * Windows can hold a briefly-closed SQLite WAL file open past `close()`. A
 * leftover temp directory is not a test failure, so removal retries and then
 * gives up to the operating system's own temp cleanup.
 */
async function removeEventually(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(directory, { recursive: true, force: true })
      return
    } catch {
      await Bun.sleep(20)
    }
  }
}

export const postgresEngine: TestEngine = {
  name: 'postgres',
  async open() {
    if (!POSTGRES_URL) throw new Error('IROHA_TEST_POSTGRES_URL is not set')

    const database = openDatabase({
      dialect: 'postgres',
      url: POSTGRES_URL,
      describe: 'postgres (test)',
    })

    // Each case starts from an empty schema so ordering cannot leak between
    // tests the way it cannot between fresh SQLite files.
    await resetPostgresSchema(POSTGRES_URL)
    await database.migrate()

    return { database, dispose: () => database.close() }
  },
}

async function resetPostgresSchema(url: string): Promise<void> {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: url })
  try {
    await pool.query('drop schema if exists public cascade')
    await pool.query('create schema public')
    await pool.query('drop table if exists "__drizzle_migrations"')
    await pool.query('drop schema if exists drizzle cascade')
  } finally {
    await pool.end()
  }
}

/** Every engine that can actually run here. */
export const availableEngines: readonly TestEngine[] = POSTGRES_URL
  ? [sqliteEngine, postgresEngine]
  : [sqliteEngine]

if (!POSTGRES_URL) {
  console.warn(
    '[iroha] PostgreSQL conformance skipped: set IROHA_TEST_POSTGRES_URL to a disposable database to run it.',
  )
}
