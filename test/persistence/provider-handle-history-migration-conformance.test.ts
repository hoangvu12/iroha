import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { POSTGRES_URL } from './engines.ts'

const SQLITE_MIGRATION = join(import.meta.dir, '../../migrations/sqlite/0019_true_mad_thinker.sql')
const POSTGRES_MIGRATION = join(import.meta.dir, '../../migrations/postgres/0020_superb_lockheed.sql')

describe('Provider Handle request-history migration', () => {
  test('SQLite preserves existing history with a null snapshot', () => {
    const database = new Database(':memory:')
    try {
      database.exec('CREATE TABLE request_events (id text PRIMARY KEY NOT NULL, provider_id text NOT NULL)')
      database.prepare('INSERT INTO request_events (id, provider_id) VALUES (?, ?)').run('req_legacy', 'pr_legacy')
      database.exec(readFileSync(SQLITE_MIGRATION, 'utf8'))

      expect(database.prepare('SELECT provider_id, provider_handle FROM request_events WHERE id = ?').get('req_legacy'))
        .toEqual({ provider_id: 'pr_legacy', provider_handle: null })
    } finally {
      database.close()
    }
  })

  test('both dialects add the same nullable Provider Handle snapshot column', () => {
    expect(readFileSync(SQLITE_MIGRATION, 'utf8')).toContain('ADD `provider_handle` text')
    expect(readFileSync(POSTGRES_MIGRATION, 'utf8')).toContain('ADD COLUMN "provider_handle" text')
  })

  const postgresTest = POSTGRES_URL === undefined ? test.skip : test
  postgresTest('PostgreSQL preserves existing history with a null snapshot', async () => {
    const { Pool } = await import('pg')
    const pool = new Pool({ connectionString: POSTGRES_URL })
    const schema = `provider_handle_history_${crypto.randomUUID().replaceAll('-', '')}`
    const client = await pool.connect()
    try {
      await client.query(`CREATE SCHEMA "${schema}"`)
      await client.query(`SET search_path TO "${schema}"`)
      await client.query('CREATE TABLE request_events (id text PRIMARY KEY NOT NULL, provider_id text NOT NULL)')
      await client.query("INSERT INTO request_events (id, provider_id) VALUES ('req_legacy', 'pr_legacy')")
      await client.query(readFileSync(POSTGRES_MIGRATION, 'utf8'))
      const result = await client.query<{ provider_id: string; provider_handle: string | null }>(
        "SELECT provider_id, provider_handle FROM request_events WHERE id = 'req_legacy'",
      )
      expect(result.rows).toEqual([{ provider_id: 'pr_legacy', provider_handle: null }])
    } finally {
      client.release()
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await pool.end()
    }
  })
})
