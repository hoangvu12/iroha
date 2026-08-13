import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database as BunSqlite } from 'bun:sqlite'
import { Pool } from 'pg'
import { POSTGRES_URL } from './engines.ts'
import { DatabaseUnavailableError, openDatabase } from '../../src/persistence/index.ts'

/**
 * The 0012 Provider-rename migration is the first one that mutates data
 * already written by previous schemas. A pure forwards-migration test
 * (migrations-conformance.test.ts) only proves the schema applies cleanly;
 * it does not prove the scope rewrite or the abort path work against real
 * rows. This suite seeds a populated fixture (one Provider, several Upstream
 * Keys with mixed base URLs, several Gateway Keys with non-empty scopes
 * containing `pc_*` references) and asserts the post-migration shape.
 *
 * A failure here means the rename cannot rewrite existing Gateway Key
 * scopes without losing or corrupting access, so the migration would
 * silently break live installations.
 */

const SQLITE_DIR = join(import.meta.dir, '../../migrations/sqlite')
const POSTGRES_DIR = join(import.meta.dir, '../../migrations/postgres')

interface AppliedFixture {
  readonly providerIds: readonly string[]
  readonly keyIds: readonly string[]
  readonly gatewayKeyIds: readonly string[]
  readonly scopeBefore: readonly { id: string; scope: string }[]
}

function seedSqliteFixture(file: string): AppliedFixture {
  const client = new BunSqlite(file, { create: true })
  client.exec('pragma foreign_keys = ON')
  try {
    const journal = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:fs').readFileSync(join(SQLITE_DIR, 'meta/_journal.json'), 'utf8'),
    ) as { entries: { tag: string; when: number; breakpoints: boolean }[] }

    // Replay migrations 0000..0011 by feeding their raw statements to the
    // same executor the forwards-migration test uses.
    const crypto = require('node:crypto') as typeof import('node:crypto')
    const appliedHashes: string[] = []
    for (const entry of journal.entries.filter((e) => e.tag !== '0012_provider_rename')) {
      const sql = require('node:fs').readFileSync(
        join(SQLITE_DIR, `${entry.tag}.sql`),
        'utf8',
      ) as string
      const hash = crypto.createHash('sha256').update(sql).digest('hex')
      appliedHashes.push(hash)
      for (const stmt of sql.split('--> statement-breakpoint').map((s) => s.trim()).filter((s) => s.length > 0)) {
        client.exec(stmt)
      }
    }
    client.exec(
      'CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
    )
    const appliedEntries = journal.entries.filter((e) => e.tag !== '0012_provider_rename')
    for (let i = 0; i < appliedEntries.length; i++) {
      client
        .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
        .run(appliedHashes[i]!, appliedEntries[i]!.when)
    }

    // Seed: one Provider, three Keys (no override, override, override that
    // matches the Provider), and three Gateway Keys whose scopes contain
    // pc_* references that must be rewritten to pr_*.
    const providerA = 'pc_alpha'
    const providerB = 'pc_beta'
    client
      .prepare(
        `INSERT INTO provider_connections (
           id, display_name, base_url, allow_insecure_http, enabled,
           retry_max_attempts, retry_ambiguous_network, archived_at,
           template_id, capabilities, auth_header, auth_prefix,
           static_headers_encrypted, redirect_allow_same_origin,
           connection_timeout_ms, first_byte_timeout_ms,
           non_streaming_total_timeout_ms, streaming_idle_timeout_ms,
           total_retry_timeout_ms, idempotency_header, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        providerA,
        'Alpha',
        'https://alpha.example.com/v1',
        0,
        1,
        3,
        0,
        null,
        null,
        JSON.stringify({ chat: true, streaming: true, tools: false, structuredOutput: false, responses: false }),
        'authorization',
        'Bearer ',
        '[]',
        0,
        10000,
        20000,
        120000,
        30000,
        30000,
        'Idempotency-Key',
        1700000000000,
        1700000000000,
      )
    client
      .prepare(
        `INSERT INTO provider_connections (
           id, display_name, base_url, allow_insecure_http, enabled,
           retry_max_attempts, retry_ambiguous_network, archived_at,
           template_id, capabilities, auth_header, auth_prefix,
           static_headers_encrypted, redirect_allow_same_origin,
           connection_timeout_ms, first_byte_timeout_ms,
           non_streaming_total_timeout_ms, streaming_idle_timeout_ms,
           total_retry_timeout_ms, idempotency_header, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        providerB,
        'Beta',
        'https://beta.example.com/v1',
        0,
        1,
        3,
        0,
        null,
        null,
        JSON.stringify({ chat: true, streaming: true, tools: false, structuredOutput: false, responses: false }),
        'authorization',
        'Bearer ',
        '[]',
        0,
        10000,
        20000,
        120000,
        30000,
        30000,
        'Idempotency-Key',
        1700000000000,
        1700000000000,
      )

    const keyA1 = 'uk_a1'
    const keyA2 = 'uk_a2'
    const keyA3 = 'uk_a3'
    const insertKey = client.prepare(
      `INSERT INTO upstream_keys (
         id, connection_id, account_id, encrypted_key, health,
         health_changed_at, health_scope, allowed_models, denied_models,
         created_at, updated_at
       ) VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    )
    insertKey.run(keyA1, providerA, 'cipher-a1', 'active', 1700000000000, 'key', 1700000000000, 1700000000000)
    insertKey.run(keyA2, providerA, 'cipher-a2', 'active', 1700000000000, 'key', 1700000000000, 1700000000000)
    insertKey.run(keyA3, providerA, 'cipher-a3', 'active', 1700000000000, 'key', 1700000000000, 1700000000000)

    const scopeRow1 = JSON.stringify([{ connectionId: providerA, models: ['gpt-4o-mini'] }])
    const scopeRow2 = JSON.stringify([
      { connectionId: providerA, models: null },
      { connectionId: providerB, models: null },
    ])
    const scopeRow3 = JSON.stringify([{ connectionId: providerB, models: ['claude-3.5'] }])
    const insertGatewayKey = client.prepare(
      `INSERT INTO gateway_keys (id, name, secret_hash, scope, cors_origins, created_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
    )
    insertGatewayKey.run('gk_one', 'Alpha only', 'hash-one', scopeRow1, '[]', 1700000000000)
    insertGatewayKey.run('gk_two', 'Both', 'hash-two', scopeRow2, '[]', 1700000000000)
    insertGatewayKey.run('gk_three', 'Beta model scope', 'hash-three', scopeRow3, '[]', 1700000000000)

    return {
      providerIds: [providerA, providerB],
      keyIds: [keyA1, keyA2, keyA3],
      gatewayKeyIds: ['gk_one', 'gk_two', 'gk_three'],
      scopeBefore: [
        { id: 'gk_one', scope: scopeRow1 },
        { id: 'gk_two', scope: scopeRow2 },
        { id: 'gk_three', scope: scopeRow3 },
      ],
    }
  } finally {
    client.close()
  }
}

async function seedPostgresFixture(url: string): Promise<AppliedFixture> {
  const pool = new Pool({ connectionString: url })
  try {
    await pool.query('drop schema if exists public cascade')
    await pool.query('create schema public')
    await pool.query('drop schema if exists drizzle cascade')

    const fs = await import('node:fs')
    const journal = JSON.parse(
      fs.readFileSync(join(POSTGRES_DIR, 'meta/_journal.json'), 'utf8'),
    ) as { entries: { tag: string; when: number; breakpoints: boolean }[] }
    for (const entry of journal.entries.filter((e) => e.tag !== '0012_provider_rename')) {
      const sql = fs.readFileSync(join(POSTGRES_DIR, `${entry.tag}.sql`), 'utf8')
      for (const stmt of sql.split('--> statement-breakpoint').map((s) => s.trim()).filter((s) => s.length > 0)) {
        await pool.query(stmt)
      }
    }
    await pool.query(
      'CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
    )

    const providerA = 'pc_alpha'
    const providerB = 'pc_beta'
    const capabilities = {
      chat: true,
      streaming: true,
      tools: false,
      structuredOutput: false,
      responses: false,
    }
    await pool.query(
      `INSERT INTO provider_connections (
         id, display_name, base_url, allow_insecure_http, enabled,
         retry_max_attempts, retry_ambiguous_network, archived_at,
         template_id, capabilities, auth_header, auth_prefix,
         static_headers_encrypted, redirect_allow_same_origin,
         connection_timeout_ms, first_byte_timeout_ms,
         non_streaming_total_timeout_ms, streaming_idle_timeout_ms,
         total_retry_timeout_ms, idempotency_header, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
      [
        providerA,
        'Alpha',
        'https://alpha.example.com/v1',
        false,
        true,
        3,
        false,
        null,
        null,
        capabilities,
        'authorization',
        'Bearer ',
        '[]',
        false,
        10000,
        20000,
        120000,
        30000,
        30000,
        'Idempotency-Key',
        new Date(1700000000000),
        new Date(1700000000000),
      ],
    )
    await pool.query(
      `INSERT INTO provider_connections (
         id, display_name, base_url, allow_insecure_http, enabled,
         retry_max_attempts, retry_ambiguous_network, archived_at,
         template_id, capabilities, auth_header, auth_prefix,
         static_headers_encrypted, redirect_allow_same_origin,
         connection_timeout_ms, first_byte_timeout_ms,
         non_streaming_total_timeout_ms, streaming_idle_timeout_ms,
         total_retry_timeout_ms, idempotency_header, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
      [
        providerB,
        'Beta',
        'https://beta.example.com/v1',
        false,
        true,
        3,
        false,
        null,
        null,
        capabilities,
        'authorization',
        'Bearer ',
        '[]',
        false,
        10000,
        20000,
        120000,
        30000,
        30000,
        'Idempotency-Key',
        new Date(1700000000000),
        new Date(1700000000000),
      ],
    )

    const keyA1 = 'uk_a1'
    const keyA2 = 'uk_a2'
    const keyA3 = 'uk_a3'
    await pool.query(
      `INSERT INTO upstream_keys (
         id, connection_id, account_id, encrypted_key, health,
         health_changed_at, health_scope, allowed_models, denied_models,
         created_at, updated_at
       ) VALUES ($1, $2, NULL, $3, $4, $5, $6, NULL, NULL, $7, $8)`,
      [keyA1, providerA, 'cipher-a1', 'active', new Date(1700000000000), 'key', new Date(1700000000000), new Date(1700000000000)],
    )
    await pool.query(
      `INSERT INTO upstream_keys (
         id, connection_id, account_id, encrypted_key, health,
         health_changed_at, health_scope, allowed_models, denied_models,
         created_at, updated_at
       ) VALUES ($1, $2, NULL, $3, $4, $5, $6, NULL, NULL, $7, $8)`,
      [keyA2, providerA, 'cipher-a2', 'active', new Date(1700000000000), 'key', new Date(1700000000000), new Date(1700000000000)],
    )
    await pool.query(
      `INSERT INTO upstream_keys (
         id, connection_id, account_id, encrypted_key, health,
         health_changed_at, health_scope, allowed_models, denied_models,
         created_at, updated_at
       ) VALUES ($1, $2, NULL, $3, $4, $5, $6, NULL, NULL, $7, $8)`,
      [keyA3, providerA, 'cipher-a3', 'active', new Date(1700000000000), 'key', new Date(1700000000000), new Date(1700000000000)],
    )

    const scopeRow1 = JSON.stringify([{ connectionId: providerA, models: ['gpt-4o-mini'] }])
    const scopeRow2 = JSON.stringify([
      { connectionId: providerA, models: null },
      { connectionId: providerB, models: null },
    ])
    const scopeRow3 = JSON.stringify([{ connectionId: providerB, models: ['claude-3.5'] }])
    await pool.query(
      `INSERT INTO gateway_keys (id, name, secret_hash, scope, cors_origins, created_at, last_used_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL)`,
      ['gk_one', 'Alpha only', 'hash-one', scopeRow1, [], new Date(1700000000000)],
    )
    await pool.query(
      `INSERT INTO gateway_keys (id, name, secret_hash, scope, cors_origins, created_at, last_used_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL)`,
      ['gk_two', 'Both', 'hash-two', scopeRow2, [], new Date(1700000000000)],
    )
    await pool.query(
      `INSERT INTO gateway_keys (id, name, secret_hash, scope, cors_origins, created_at, last_used_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL)`,
      ['gk_three', 'Beta model scope', 'hash-three', scopeRow3, [], new Date(1700000000000)],
    )

    return {
      providerIds: [providerA, providerB],
      keyIds: [keyA1, keyA2, keyA3],
      gatewayKeyIds: ['gk_one', 'gk_two', 'gk_three'],
      scopeBefore: [
        { id: 'gk_one', scope: scopeRow1 },
        { id: 'gk_two', scope: scopeRow2 },
        { id: 'gk_three', scope: scopeRow3 },
      ],
    }
  } finally {
    await pool.end()
  }
}

describe('SQLite Provider-rename migration on a populated fixture', () => {
  const tempDirectories: string[] = []

  function freshFile(label: string): string {
    const directory = mkdtempSync(join(tmpdir(), `iroha-rename-${process.pid}-${label}-`))
    tempDirectories.push(directory)
    return join(directory, 'iroha.db')
  }

  afterEach(() => {
    while (tempDirectories.length > 0) {
      const directory = tempDirectories.shift()!
      try {
        rmSync(directory, { recursive: true, force: true })
      } catch {
        // SQLite WAL on Windows can survive a close; a leftover directory is
        // not a test failure.
      }
    }
  })

  test('renames tables and columns, rewrites gateway_keys.scope, and adds upstream_keys.base_url', async () => {
    const file = freshFile('apply')
    const fixture = seedSqliteFixture(file)
    const database = openDatabase({
      dialect: 'sqlite',
      file,
      ephemeral: false,
      describe: 'sqlite (rename on populated fixture)',
    })
    try {
      await database.migrate()

      // The renamed Provider table is reachable by its new name and every
      // underlying ID value is preserved across the prefix change.
      const alpha = await database.providers.getProvider('pc_alpha')
      expect(alpha?.displayName).toBe('Alpha'); expect(alpha?.id).toBe('pc_alpha')
      expect(alpha?.baseUrl).toBe('https://alpha.example.com/v1')
      const beta = await database.providers.getProvider('pc_beta')
      expect(beta?.displayName).toBe('Beta'); expect(beta?.id).toBe('pc_beta')

      // Three keys belong to pr_alpha and round-trip their cipher output.
      const keys = await database.providers.listKeys('pc_alpha')
      expect(keys.map((k) => k.id).sort()).toEqual(['uk_a1', 'uk_a2', 'uk_a3']); expect(keys.every((k) => k.providerId === 'pc_alpha')).toBe(true)
      for (const key of keys) {
        expect(key.providerId).toBe('pc_alpha')
      }

      // Gateway Key scopes must have rewritten every pc_* literal to pr_*,
      // preserving the underlying suffix and any model lists.
      const gkOne = await database.gatewayKeys.get('gk_one')
      expect(gkOne?.scope).toEqual([{ providerId: 'pr_alpha', models: ['gpt-4o-mini'] }])
      const gkTwo = await database.gatewayKeys.get('gk_two')
      expect(gkTwo?.scope).toEqual([
        { providerId: 'pr_alpha', models: null },
        { providerId: 'pr_beta', models: null },
      ])
      const gkThree = await database.gatewayKeys.get('gk_three')
      expect(gkThree?.scope).toEqual([{ providerId: 'pr_beta', models: ['claude-3.5'] }])

      // No pc_* literals survive anywhere.
      for (const { scope } of fixture.scopeBefore) {
        expect(scope).toContain('pc_')
      }
      const after = (
        await Promise.all([
          database.gatewayKeys.get('gk_one'),
          database.gatewayKeys.get('gk_two'),
          database.gatewayKeys.get('gk_three'),
        ])
      ).map((row) => JSON.stringify(row?.scope))
      for (const scope of after) {
        expect(scope).not.toContain('pc_')
      }
    } finally {
      await database.close()
    }
  })

  test('adds a nullable base_url column on upstream_keys and rejects a stale pc_* scope reference', async () => {
    const file = freshFile('abort')
    // Seed through the same apply path so the schema is fully migrated up to
    // 0011, then poison one scope with an unresolvable pc_* literal before
    // applying the 0012 rename.
    const client = new BunSqlite(file, { create: true })
    client.exec('pragma foreign_keys = ON')
    try {
      const fs = require('node:fs') as typeof import('node:fs')
      const journal = JSON.parse(
        fs.readFileSync(join(SQLITE_DIR, 'meta/_journal.json'), 'utf8'),
      ) as { entries: { tag: string; when: number }[] }
      const crypto = require('node:crypto') as typeof import('node:crypto')
      client.exec(
        'CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
      )
      for (const entry of journal.entries.filter((e) => e.tag !== '0012_provider_rename')) {
        const sql = fs.readFileSync(join(SQLITE_DIR, `${entry.tag}.sql`), 'utf8')
        const hash = crypto.createHash('sha256').update(sql).digest('hex')
        for (const stmt of sql.split('--> statement-breakpoint').map((s) => s.trim()).filter((s) => s.length > 0)) {
          client.exec(stmt)
        }
        client
          .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
          .run(hash, entry.when)
      }
      // One real Provider, one poisoned Gateway Key scope referencing a
      // pc_* id that does NOT exist in provider_connections.
      client
        .prepare(
          `INSERT INTO provider_connections (
             id, display_name, base_url, allow_insecure_http, enabled,
             retry_max_attempts, retry_ambiguous_network, archived_at,
             template_id, capabilities, auth_header, auth_prefix,
             static_headers_encrypted, redirect_allow_same_origin,
             connection_timeout_ms, first_byte_timeout_ms,
             non_streaming_total_timeout_ms, streaming_idle_timeout_ms,
             total_retry_timeout_ms, idempotency_header, created_at, updated_at
           ) VALUES ('pc_real', 'Real', 'https://real.example.com/v1', 0, 1, 3, 0, NULL, NULL,
             '{"chat":false,"streaming":false,"tools":false,"structuredOutput":false,"responses":false}',
             'authorization', 'Bearer ', '[]', 0, 10000, 20000, 120000, 30000, 30000,
             'Idempotency-Key', 1700000000000, 1700000000000)`,
        )
        .run()
      client
        .prepare(
          `INSERT INTO gateway_keys (id, name, secret_hash, scope, cors_origins, created_at, last_used_at, revoked_at)
           VALUES ('gk_poisoned', 'Poisoned', 'hash-poison', ?, '[]', 1700000000000, NULL, NULL)`,
        )
        .run(JSON.stringify([{ connectionId: 'pc_does_not_exist', models: null }]))
    } finally {
      client.close()
    }

    const database = openDatabase({
      dialect: 'sqlite',
      file,
      ephemeral: false,
      describe: 'sqlite (rename aborts on unmapped scope)',
    })
    try {
      await expect(database.migrate()).rejects.toThrow(DatabaseUnavailableError)

      // The migration must have aborted before renaming: the old table is
      // still present and the scope literal is still pc_*.
      const after = new BunSqlite(file, { readonly: true })
      try {
        const tables = (
          after
            .query("select name from sqlite_master where type = 'table'")
            .all() as { name: string }[]
        ).map((row) => row.name)
        expect(tables).toContain('provider_connections')
        expect(tables).not.toContain('providers')

        const row = after
          .query("select scope from gateway_keys where id = 'gk_poisoned'")
          .get() as { scope: string } | null
        expect(row?.scope).toContain('pc_does_not_exist')
      } finally {
        after.close()
      }
    } finally {
      await database.close()
    }
  })
})

if (POSTGRES_URL) {
  describe('PostgreSQL Provider-rename migration on a populated fixture', () => {
    test('renames tables and columns, rewrites gateway_keys.scope, and adds upstream_keys.base_url', async () => {
      const fixture = await seedPostgresFixture(POSTGRES_URL ?? '')
      const database = openDatabase({
        dialect: 'postgres',
        url: POSTGRES_URL ?? '',
        describe: 'postgres (rename on populated fixture)',
      })
      try {
        await database.migrate()

        const alpha = await database.providers.getProvider('pc_alpha')
        expect(alpha?.displayName).toBe('Alpha'); expect(alpha?.id).toBe('pc_alpha')
        const beta = await database.providers.getProvider('pc_beta')
        expect(beta?.displayName).toBe('Beta'); expect(beta?.id).toBe('pc_beta')

        const keys = await database.providers.listKeys('pc_alpha')
        expect(keys.map((k) => k.id).sort()).toEqual(['uk_a1', 'uk_a2', 'uk_a3']); expect(keys.every((k) => k.providerId === 'pc_alpha')).toBe(true)

        const gkOne = await database.gatewayKeys.get('gk_one')
        expect(gkOne?.scope).toEqual([{ providerId: 'pr_alpha', models: ['gpt-4o-mini'] }])
        const gkTwo = await database.gatewayKeys.get('gk_two')
        expect(gkTwo?.scope).toEqual([
          { providerId: 'pr_alpha', models: null },
          { providerId: 'pr_beta', models: null },
        ])
        const gkThree = await database.gatewayKeys.get('gk_three')
        expect(gkThree?.scope).toEqual([{ providerId: 'pr_beta', models: ['claude-3.5'] }])

        for (const { scope } of fixture.scopeBefore) {
          expect(scope).toContain('pc_')
        }
        const after = (
          await Promise.all([
            database.gatewayKeys.get('gk_one'),
            database.gatewayKeys.get('gk_two'),
            database.gatewayKeys.get('gk_three'),
          ])
        ).map((row) => JSON.stringify(row?.scope))
        for (const scope of after) {
          expect(scope).not.toContain('pc_')
        }
      } finally {
        await database.close()
      }
    })

    test('rejects a stale pc_* scope reference with a clear error', async () => {
      // Seed with one real Provider and one poisoned Gateway Key that
      // references a pc_* id which does not exist in provider_connections.
      const pool = new Pool({ connectionString: POSTGRES_URL })
      try {
        await pool.query('drop schema if exists public cascade')
        await pool.query('create schema public')
        await pool.query('drop schema if exists drizzle cascade')
        const fs = await import('node:fs')
        const journal = JSON.parse(
          fs.readFileSync(join(POSTGRES_DIR, 'meta/_journal.json'), 'utf8'),
        ) as { entries: { tag: string; when: number }[] }
        for (const entry of journal.entries.filter((e) => e.tag !== '0012_provider_rename')) {
          const sql = fs.readFileSync(join(POSTGRES_DIR, `${entry.tag}.sql`), 'utf8')
          for (const stmt of sql.split('--> statement-breakpoint').map((s) => s.trim()).filter((s) => s.length > 0)) {
            await pool.query(stmt)
          }
        }
        const capabilities = {
          chat: false,
          streaming: false,
          tools: false,
          structuredOutput: false,
          responses: false,
        }
        await pool.query(
          `INSERT INTO provider_connections (
             id, display_name, base_url, allow_insecure_http, enabled,
             retry_max_attempts, retry_ambiguous_network, archived_at,
             template_id, capabilities, auth_header, auth_prefix,
             static_headers_encrypted, redirect_allow_same_origin,
             connection_timeout_ms, first_byte_timeout_ms,
             non_streaming_total_timeout_ms, streaming_idle_timeout_ms,
             total_retry_timeout_ms, idempotency_header, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
          [
            'pc_real',
            'Real',
            'https://real.example.com/v1',
            false,
            true,
            3,
            false,
            null,
            null,
            capabilities,
            'authorization',
            'Bearer ',
            '[]',
            false,
            10000,
            20000,
            120000,
            30000,
            30000,
            'Idempotency-Key',
            new Date(1700000000000),
            new Date(1700000000000),
          ],
        )
        await pool.query(
          `INSERT INTO gateway_keys (id, name, secret_hash, scope, cors_origins, created_at, last_used_at, revoked_at)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, NULL, NULL)`,
          [
            'gk_poisoned',
            'Poisoned',
            'hash-poison',
            JSON.stringify([{ connectionId: 'pc_does_not_exist', models: null }]),
            [],
            new Date(1700000000000),
          ],
        )
      } finally {
        await pool.end()
      }

      const database = openDatabase({
        dialect: 'postgres',
        url: POSTGRES_URL ?? '',
        describe: 'postgres (rename aborts on unmapped scope)',
      })
      try {
        await expect(database.migrate()).rejects.toThrow(DatabaseUnavailableError)

        // The migration must have aborted before renaming: the old table is
        // still present and the scope literal is still pc_*.
        const verify = new Pool({ connectionString: POSTGRES_URL ?? '' })
        try {
          const tableCheck = await verify.query<{ table_name: string }>(
            "select table_name from information_schema.tables where table_schema = 'public' and table_name = 'providers'",
          )
          expect(tableCheck.rows).toEqual([])
          const row = await verify.query<{ scope: unknown }>(
            "select scope from gateway_keys where id = 'gk_poisoned'",
          )
          expect(JSON.stringify(row.rows[0]?.scope)).toContain('pc_does_not_exist')
        } finally {
          await verify.end()
        }
      } finally {
        await database.close()
      }
    })
  })
}