/**
 * Removes duplicate Upstream Keys: rows that hold the same decrypted key
 * value on the same Provider. These come from overlapping import rounds that
 * used different id schemes, and they make the round-robin rotate over one
 * credential several times before moving on.
 *
 * Within each duplicate group the earliest-created row is kept (it carries the
 * key's health history); the rest are deleted with a `key.removed` audit row,
 * matching what the management UI would have written. Keys shared across two
 * different Providers are intentionally kept on both.
 *
 * Usage:
 *   bun run scripts/dedupe-upstream-keys.ts            # dry run
 *   bun run scripts/dedupe-upstream-keys.ts --apply
 */
import { loadConfiguration } from '../src/config/environment.ts'
import { openDatabase } from '../src/persistence/index.ts'
import { createSecretCipher, SecretCipherError } from '../src/crypto/index.ts'

const APPLY = process.argv.includes('--apply')

const config = loadConfiguration()
const db = openDatabase(config.database)
const cipher = createSecretCipher(config.masterKey)

interface KeyRow {
  readonly id: string
  readonly providerId: string
  readonly health: string
  readonly baseUrl: string | null
  readonly encryptedKey: string
  readonly createdAt: Date
}

try {
  const allProviders = await db.providers.listProviders()
  const rows: KeyRow[] = []
  for (const provider of allProviders) {
    const providerRows = (await db.providers.listKeys(provider.id)) as readonly KeyRow[]
    for (const row of providerRows) rows.push({ ...row, providerId: provider.id })
  }

  const groups = new Map<string, { readonly providerId: string; readonly rows: KeyRow[] }>()
  let unreadable = 0
  for (const row of rows) {
    let plaintext: string
    try {
      plaintext = await cipher.decrypt(row.encryptedKey)
    } catch (cause) {
      if (cause instanceof SecretCipherError) {
        unreadable += 1
        continue
      }
      throw cause
    }
    const groupKey = `${row.providerId}\u0000${plaintext}`
    const group = groups.get(groupKey)
    if (group === undefined) groups.set(groupKey, { providerId: row.providerId, rows: [row] })
    else (group.rows as KeyRow[]).push(row)
  }

  const duplicates = [...groups.values()].filter((g) => g.rows.length > 1)
  console.log(`${rows.length} key row(s), ${groups.size} unique (provider, key) pair(s), ${unreadable} unreadable`)
  console.log(`${duplicates.length} duplicate group(s)\n`)

  let toDelete = 0
  for (const group of duplicates) {
    const ordered = [...group.rows].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1),
    )
    const keep = ordered[0]
    const drop = ordered.slice(1)
    toDelete += drop.length
    console.log(`  keep ${keep.id} (${keep.health}), drop ${drop.map((d) => `${d.id}(${d.health})`).join(', ')}`)

    if (!APPLY) continue
    const at = new Date()
    for (const row of drop) {
      await db.transaction(async (repositories) => {
        await repositories.providers.deleteKey(row.id)
        await repositories.audit.record({
          action: 'key.removed',
          outcome: 'success',
          detail: {
            providerId: row.providerId,
            keyId: row.id,
            reason: 'duplicate of kept key',
            keptKeyId: keep.id,
          },
          at,
        })
      })
    }
  }

  console.log(`\n${toDelete} row(s) ${APPLY ? 'deleted' : 'would be deleted'}; ${rows.length - toDelete} remain.`)
  if (!APPLY && toDelete > 0) console.log('Dry run. Pass --apply to write the changes.')
} finally {
  await db.close()
}
