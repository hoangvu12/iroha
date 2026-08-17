import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { Database as BunSqlite } from 'bun:sqlite'

const SQLITE_MIGRATION = join(import.meta.dir, '../../migrations/sqlite/0020_overjoyed_victor_mancha.sql')
const POSTGRES_MIGRATION = join(import.meta.dir, '../../migrations/postgres/0021_complete_marvel_boy.sql')

describe('Provider Logo Domain migration', () => {
  test('SQLite backfills branded, generic, and invalid existing Providers', async () => {
    const database = new BunSqlite(':memory:')
    try {
      database.exec('create table providers (id text primary key, template_id text, base_url text not null)')
      const insert = database.prepare('insert into providers (id, template_id, base_url) values (?, ?, ?)')
      insert.run('branded', 'openai', 'not-a-url')
      insert.run('generic', 'generic-openai-compatible', 'https://API.Example.com:8443/v1')
      insert.run('invalid', 'generic-openai-compatible', 'not-a-url')

      for (const statement of statements(await readFile(SQLITE_MIGRATION, 'utf8'))) database.exec(statement)

      expect(database.query('select id, logo_domain as logoDomain from providers order by id').all()).toEqual([
        { id: 'branded', logoDomain: 'openai.com' },
        { id: 'generic', logoDomain: 'api.example.com' },
        { id: 'invalid', logoDomain: null },
      ])
    } finally {
      database.close()
    }
  })

  test('PostgreSQL migration carries equivalent branded and generic backfills', async () => {
    const sql = await readFile(POSTGRES_MIGRATION, 'utf8')
    expect(sql).toContain("WHEN 'openai' THEN 'openai.com'")
    expect(sql).toContain("WHEN 'anthropic' THEN 'anthropic.com'")
    expect(sql).toContain("regexp_replace(base_url, '^https?://', '', 'i')")
    expect(sql).toContain('SET logo_domain = valid_base_hosts.hostname')
  })
})

function statements(sql: string): readonly string[] {
  return sql.split('--> statement-breakpoint').map((statement) => statement.trim()).filter(Boolean)
}
