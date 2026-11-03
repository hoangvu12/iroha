/**
 * Temporarily narrow routing to one allowlist of Upstream Keys.
 *
 * Reads a JSON array of `{ key: "sk-..." }` entries, decrypts every Upstream
 * Key in the database, and Owner-disables every key whose plaintext is NOT in
 * that file. Keys that ARE in the file and currently Owner-disabled are
 * activated, so the allowlist is exactly the set the Gateway may route to.
 *
 * The previous health of every key it touches is written to a snapshot file so
 * `--restore` can put the whole database back exactly as it was. Health states
 * the Key Health engine owns (cooling_down, exhausted, invalid_authentication)
 * are never manufactured — only recorded and replayed.
 *
 * Usage:
 *   bun run scripts/scope-keys-to-file.ts <allowlist.json>            # dry run
 *   bun run scripts/scope-keys-to-file.ts <allowlist.json> --apply
 *   bun run scripts/scope-keys-to-file.ts --restore                   # dry run
 *   bun run scripts/scope-keys-to-file.ts --restore --apply
 *
 * Optional: --snapshot <path>       (default .scratch/key-scope-snapshot.json)
 *           --provider <handle|id>  narrow the sweep to one Provider; keys on
 *                                   every other Provider are left untouched
 */
import { loadConfiguration } from '../src/config/environment.ts'
import { openDatabase } from '../src/persistence/index.ts'
import { createSecretCipher, SecretCipherError } from '../src/crypto/index.ts'
import type { UpstreamKeyHealth, UpstreamKeyRecord } from '../src/persistence/repository.ts'

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const RESTORE = argv.includes('--restore')
const snapshotFlag = argv.indexOf('--snapshot')
const SNAPSHOT_PATH =
  snapshotFlag === -1 ? '.scratch/key-scope-snapshot.json' : (argv[snapshotFlag + 1] ?? '')
/** Handle or ID of the only Provider to touch; unset means every Provider. */
const providerFlag = argv.indexOf('--provider')
const PROVIDER = providerFlag === -1 ? null : (argv[providerFlag + 1] ?? '')
const valueIndexes = new Set(
  [snapshotFlag, providerFlag].filter((index) => index !== -1).map((index) => index + 1),
)
const allowlistPath = argv.find(
  (arg, index) => !arg.startsWith('--') && !valueIndexes.has(index),
)

if (!RESTORE && allowlistPath === undefined) {
  console.error('Usage: bun run scripts/scope-keys-to-file.ts <allowlist.json> [--apply]')
  console.error('       bun run scripts/scope-keys-to-file.ts --restore [--apply]')
  process.exit(1)
}
if (SNAPSHOT_PATH === '') {
  console.error('--snapshot needs a path')
  process.exit(1)
}
if (PROVIDER === '') {
  console.error('--provider needs a Provider handle or ID')
  process.exit(1)
}

/** The health fields this script rewrites, captured before it touches a key. */
interface SnapshotEntry {
  readonly keyId: string
  readonly providerId: string
  readonly providerHandle: string
  readonly health: UpstreamKeyHealth
  readonly healthReason: string | null
  readonly healthChangedAt: string
  readonly retryAfterAt: string | null
  readonly healthScope: string
  readonly healthScopeId: string | null
  readonly healthModel: string | null
}

const snapshotOf = (key: UpstreamKeyRecord, providerHandle: string): SnapshotEntry => ({
  keyId: key.id,
  providerId: key.providerId,
  providerHandle,
  health: key.health,
  healthReason: key.healthReason,
  healthChangedAt: key.healthChangedAt.toISOString(),
  retryAfterAt: key.retryAfterAt === null ? null : key.retryAfterAt.toISOString(),
  healthScope: key.healthScope,
  healthScopeId: key.healthScopeId,
  healthModel: key.healthModel,
})

const config = loadConfiguration()
const db = openDatabase(config.database)
const cipher = createSecretCipher(config.masterKey)

try {
  if (RESTORE) {
    const file = Bun.file(SNAPSHOT_PATH)
    if (!(await file.exists())) {
      console.error(`No snapshot at ${SNAPSHOT_PATH}; nothing to restore.`)
      process.exit(1)
    }
    const entries = (await file.json()) as readonly SnapshotEntry[]
    let restored = 0
    for (const entry of entries) {
      const current = await db.providers.getKey(entry.keyId)
      if (current === null) {
        console.log(`${entry.keyId}  GONE (key no longer exists)`)
        continue
      }
      if (current.health === entry.health) {
        console.log(`${entry.keyId}  already ${entry.health}`)
        continue
      }
      console.log(`${entry.keyId}  ${current.health} -> ${entry.health}  [${entry.providerHandle}]`)
      restored += 1
      if (!APPLY) continue
      const at = new Date()
      await db.transaction(async (repositories) => {
        await repositories.providers.updateKey(
          entry.keyId,
          {
            health: entry.health,
            healthReason: entry.healthReason,
            healthChangedAt: new Date(entry.healthChangedAt),
            retryAfterAt: entry.retryAfterAt === null ? null : new Date(entry.retryAfterAt),
            healthScope: entry.healthScope as never,
            healthScopeId: entry.healthScopeId,
            healthModel: entry.healthModel,
          } as never,
          at,
        )
        await repositories.audit.record({
          action: entry.health === 'disabled' ? 'key.disabled' : 'key.activated',
          outcome: 'success',
          detail: {
            providerId: entry.providerId,
            keyId: entry.keyId,
            reason: 'scope-keys-to-file restore',
            previousHealth: current.health,
            newHealth: entry.health,
          },
          at,
        })
      })
    }
    console.log('')
    console.log(`${entries.length} snapshot entr(ies), ${restored} would change.`)
    if (APPLY) {
      await Bun.write(`${SNAPSHOT_PATH}.restored`, JSON.stringify(entries, null, 2))
      console.log(`Snapshot kept at ${SNAPSHOT_PATH}.restored`)
    } else if (restored > 0) {
      console.log('Dry run. Pass --apply to write the changes.')
    }
    process.exit(0)
  }

  const allowlistFile = (await Bun.file(allowlistPath as string).json()) as readonly {
    key?: unknown
    candidateId?: unknown
  }[]
  const allowed = new Set<string>()
  for (const entry of allowlistFile) {
    if (typeof entry.key === 'string' && entry.key.trim() !== '') allowed.add(entry.key.trim())
  }
  if (allowed.size === 0) throw new Error(`No "key" values found in ${allowlistPath}`)
  console.log(`Allowlist: ${allowed.size} distinct key(s) from ${allowlistPath}`)

  const allProviders = await db.providers.listProviders()
  const providers =
    PROVIDER === null
      ? allProviders
      : allProviders.filter(
          (provider) => provider.handle === PROVIDER || provider.id === PROVIDER,
        )
  if (providers.length === 0) throw new Error(`No Provider matches ${PROVIDER}`)
  if (PROVIDER !== null) {
    console.log(`Scoped to Provider: ${providers.map((provider) => provider.handle).join(', ')}`)
  }
  /**
   * The sweep runs in two passes: the whole plan is computed and its snapshot
   * written to disk BEFORE a single key moves. A run interrupted mid-apply then
   * still leaves a complete undo record on disk.
   */
  interface PlannedChange {
    readonly key: UpstreamKeyRecord
    readonly providerHandle: string
    readonly target: 'disabled' | 'active'
  }

  const plan: PlannedChange[] = []
  const matched = new Set<string>()
  let scanned = 0
  let unreadable = 0
  let alreadyDisabled = 0

  for (const provider of providers) {
    const keys = await db.providers.listKeys(provider.id)
    for (const key of keys) {
      scanned += 1
      let plaintext: string
      try {
        plaintext = await cipher.decrypt(key.encryptedKey)
      } catch (cause) {
        if (!(cause instanceof SecretCipherError)) throw cause
        unreadable += 1
        console.log(`${provider.handle}/${key.id}  UNREADABLE (wrong master key) — left as ${key.health}`)
        continue
      }

      if (allowed.has(plaintext)) {
        matched.add(plaintext)
        if (key.health !== 'disabled') continue
        console.log(`${provider.handle}/${key.id}  disabled -> active   (in allowlist)`)
        plan.push({ key, providerHandle: provider.handle, target: 'active' })
        continue
      }

      if (key.health === 'disabled') {
        alreadyDisabled += 1
        continue
      }
      console.log(`${provider.handle}/${key.id}  ${key.health} -> disabled  (not in allowlist)`)
      plan.push({ key, providerHandle: provider.handle, target: 'disabled' })
    }
  }

  const snapshot = plan.map((change) => snapshotOf(change.key, change.providerHandle))
  const toDisable = plan.filter((change) => change.target === 'disabled').length
  const toActivate = plan.length - toDisable

  if (APPLY && snapshot.length > 0) {
    await Bun.write(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2))
    console.log('')
    console.log(`Snapshot of ${snapshot.length} previous health state(s) -> ${SNAPSHOT_PATH}`)
  }

  if (APPLY) {
    for (const { key, providerHandle, target } of plan) {
      const at = new Date()
      const patch =
        target === 'active'
          ? {
              health: 'active',
              healthReason: 'enabled by scope-keys-to-file allowlist',
              healthChangedAt: at,
              retryAfterAt: null,
              healthScope: 'key',
              healthScopeId: null,
              healthModel: null,
            }
          : {
              health: 'disabled',
              healthReason: 'disabled by Owner',
              healthChangedAt: at,
              retryAfterAt: null,
              healthScope: 'key',
              healthScopeId: key.id,
              healthModel: null,
            }
      await db.transaction(async (repositories) => {
        await repositories.providers.updateKey(key.id, patch as never, at)
        await repositories.audit.record({
          action: target === 'active' ? 'key.activated' : 'key.disabled',
          outcome: 'success',
          detail: { providerId: key.providerId, keyId: key.id, reason: 'scope-keys-to-file' },
          at,
        })
      })
      console.log(`  applied ${providerHandle}/${key.id} -> ${target}`)
    }
  }

  const missing = [...allowed].filter((key) => !matched.has(key))
  console.log('')
  console.log(`${scanned} key(s) scanned across ${providers.length} provider(s).`)
  console.log(`  ${matched.size}/${allowed.size} allowlist key(s) found in the database`)
  console.log(`  ${toDisable} to disable, ${toActivate} to re-activate, ${alreadyDisabled} already disabled`)
  if (unreadable > 0) console.log(`  ${unreadable} unreadable with this master key (untouched)`)
  if (missing.length > 0) {
    console.log(`  ${missing.length} allowlist key(s) are NOT in the database:`)
    for (const key of missing) console.log(`    ${key.slice(0, 7)}…${key.slice(-4)}`)
  }

  if (APPLY) {
    if (snapshot.length > 0) {
      console.log(`Undo with: bun run scripts/scope-keys-to-file.ts --restore --apply`)
    }
  } else if (snapshot.length > 0) {
    console.log('')
    console.log('Dry run. Pass --apply to write the changes.')
  }
} finally {
  await db.close()
}
