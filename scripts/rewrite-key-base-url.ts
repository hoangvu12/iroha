/**
 * One-shot DB rewrite for a per-Key base URL override on a single Provider.
 *
 * Walks every Upstream Key on the named Provider whose `base_url` exactly
 * equals `--from`, rewrites that column to `--to`, and writes one
 * `key.configured` audit row per affected key — matching what
 * `ProviderRegistry.updateKeySettings` would have written if the Owner had
 * saved each key through the dialog. Run on the live Neon DB that the dev
 * server is reading from; safe to run while the dev server is up because
 * Postgres serialises the conflicting UPDATEs through row locks.
 *
 * Usage:
 *   bun run scripts/rewrite-key-base-url.ts \
 *       --provider pr_dNUEeqqCrrBd2oagWPbLkw \
 *       --from 'https://api.minimax.io/anthropic' \
 *       --to   'https://api.minimax.io/anthropic/v1'
 *
 *   # apply (omit --apply for a dry-run):
 *   bun run scripts/rewrite-key-base-url.ts --provider … --from … --to … --apply
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'

const envFile = resolve(process.cwd(), '.env')
for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  const eq = trimmed.indexOf('=')
  if (eq < 0) continue
  const key = trimmed.slice(0, eq).trim()
  const value = trimmed.slice(eq + 1).trim()
  if (!(key in process.env)) process.env[key] = value
}

const FLAG_KEYS = new Set(['apply'])
const args = new Map<string, string | boolean>()
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]
  if (!arg.startsWith('--')) throw new Error(`unexpected positional: ${arg}`)
  const key = arg.slice(2)
  const eq = key.indexOf('=')
  if (eq >= 0) {
    args.set(key.slice(0, eq), key.slice(eq + 1))
    continue
  }
  const next = process.argv[i + 1]
  if (FLAG_KEYS.has(key) || next === undefined || next.startsWith('--')) {
    args.set(key, true)
    continue
  }
  args.set(key, next)
  i++
}

const PROVIDER_ID = args.get('provider')
const FROM_URL = args.get('from')
const TO_URL = args.get('to')
const APPLY = args.get('apply') === true

if (!PROVIDER_ID || !FROM_URL || !TO_URL) {
  throw new Error('usage: --provider <id> --from <url> --to <url> [--apply]')
}

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) throw new Error('DATABASE_URL missing from .env')

interface Affected {
  readonly id: string
  readonly previous: string
}

async function run(): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL })
  await client.connect()

  try {
    const providerExists = await client.query<{ id: string }>(
      'SELECT id FROM providers WHERE id = $1',
      [PROVIDER_ID],
    )
    if (providerExists.rowCount === 0) {
      throw new Error(`Provider ${PROVIDER_ID} not found`)
    }

    const matches = await client.query<{ id: string; base_url: string }>(
      `SELECT id, base_url
         FROM upstream_keys
         WHERE provider_id = $1 AND base_url = $2
         ORDER BY id`,
      [PROVIDER_ID, FROM_URL],
    )

    if (matches.rowCount === 0) {
      console.log(`No keys on ${PROVIDER_ID} with base_url=${JSON.stringify(FROM_URL)}.`)
      return
    }

    const affected: Affected[] = matches.rows.map((row) => ({
      id: row.id,
      previous: row.base_url,
    }))

    console.log(
      `Found ${affected.length} key(s) on ${PROVIDER_ID} with base_url=${JSON.stringify(FROM_URL)}:`,
    )
    for (const entry of affected) {
      console.log(`  ${entry.id}  ${entry.previous}  ->  ${TO_URL}`)
    }

    if (!APPLY) {
      console.log('Dry run. Pass --apply to write the change.')
      return
    }

    await client.query('BEGIN')
    try {
      const now = new Date().toISOString()
      const update = await client.query<{ id: string }>(
        `UPDATE upstream_keys
            SET base_url = $1, updated_at = $2
          WHERE provider_id = $3 AND base_url = $4
          RETURNING id`,
        [TO_URL, now, PROVIDER_ID, FROM_URL],
      )

      const updatedIds = new Set(update.rows.map((row) => row.id))
      if (updatedIds.size !== affected.length) {
        throw new Error(
          `Update affected ${updatedIds.size} rows, expected ${affected.length} — aborting.`,
        )
      }

      const auditInsert = await client.query(
        `INSERT INTO audit_events (occurred_at, action, outcome, detail)
         SELECT $1::timestamptz, 'key.configured', 'success', jsonb_build_object(
                   'providerId', $2::text,
                   'keyId', id,
                   'fields', jsonb_build_array('baseUrl')
                 )
           FROM unnest($3::text[]) AS id`,
        [
          now,
          PROVIDER_ID,
          affected.map((entry) => entry.id),
        ],
      )

      if (auditInsert.rowCount === null || auditInsert.rowCount !== affected.length) {
        throw new Error(
          `Audit insert wrote ${auditInsert.rowCount ?? 'unknown'} rows, expected ${affected.length} — rolling back.`,
        )
      }

      await client.query('COMMIT')
      console.log(
        `Updated ${affected.length} key(s) and wrote ${auditInsert.rowCount} audit row(s).`,
      )
    } catch (cause) {
      await client.query('ROLLBACK')
      throw cause
    }
  } finally {
    await client.end()
  }
}

await run()
