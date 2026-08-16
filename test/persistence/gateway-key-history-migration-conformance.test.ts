import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

const SQLITE_MIGRATION = join(import.meta.dir, '../../migrations/sqlite/0016_breezy_hitman.sql')
const POSTGRES_MIGRATION = join(import.meta.dir, '../../migrations/postgres/0017_living_wolfsbane.sql')

describe('Gateway Key history snapshot migration', () => {
  test('SQLite backfills a pre-migration request name that survives key deletion', () => {
    const database = new Database(':memory:')
    try {
      database.exec('CREATE TABLE gateway_keys (id text PRIMARY KEY NOT NULL, name text NOT NULL)')
      database.exec('CREATE TABLE request_events (id text PRIMARY KEY NOT NULL, gateway_key_id text)')
      database.prepare('INSERT INTO gateway_keys (id, name) VALUES (?, ?)').run('gk_legacy', 'Legacy application')
      database.prepare('INSERT INTO request_events (id, gateway_key_id) VALUES (?, ?)').run('req_legacy', 'gk_legacy')

      for (const statement of statements(readFileSync(SQLITE_MIGRATION, 'utf8'))) database.exec(statement)
      database.prepare('DELETE FROM gateway_keys WHERE id = ?').run('gk_legacy')

      expect(database.prepare('SELECT gateway_key_id, gateway_key_name FROM request_events WHERE id = ?').get('req_legacy'))
        .toEqual({ gateway_key_id: 'gk_legacy', gateway_key_name: 'Legacy application' })
    } finally {
      database.close()
    }
  })

  test('PostgreSQL migration contains the equivalent populated-fixture backfill', () => {
    const sql = readFileSync(POSTGRES_MIGRATION, 'utf8')
    expect(sql).toContain('UPDATE "request_events"')
    expect(sql).toContain('FROM "gateway_keys"')
    expect(sql).toContain('"gateway_key_name" = "gateway_keys"."name"')
    expect(sql).toContain('"request_events"."gateway_key_id" = "gateway_keys"."id"')
  })
})

function statements(sql: string): readonly string[] {
  return sql.split('--> statement-breakpoint').map((statement) => statement.trim()).filter(Boolean)
}
