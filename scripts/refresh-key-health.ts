/**
 * One-shot diagnostic + repair: re-probe every key on a Provider against its
 * OWN effective base URL (per-key override or Provider default) and reconcile
 * the stored health with the verdict — the same mapping the app's probe test
 * uses (usable → active, rejected → invalid_authentication, inconclusive →
 * cooling_down, disabled keys are left alone). Writes one `key.tested` audit
 * row per key, matching `ProviderRegistry.testKey`.
 *
 * Run on the live Neon DB that the dev server reads from. Probe-only (no
 * --apply) prints the health it WOULD set without writing anything.
 *
 * Usage:
 *   bun run scripts/refresh-key-health.ts <provider-id> [--apply]
 */
import { loadConfiguration } from '../src/config/environment.ts'
import { openDatabase } from '../src/persistence/index.ts'
import { createSecretCipher, SecretCipherError } from '../src/crypto/index.ts'
import { createGenericKeyProbe } from '../src/providers/index.ts'

const providerId = process.argv[2]
const APPLY = process.argv.includes('--apply')
if (!providerId) {
  console.error('Usage: bun run scripts/refresh-key-health.ts <provider-id> [--apply]')
  process.exit(1)
}

const config = loadConfiguration()
const db = openDatabase(config.database)
const cipher = createSecretCipher(config.masterKey)
const probe = createGenericKeyProbe()

interface Outcome {
  readonly id: string
  readonly previousHealth: string
  readonly newHealth: string
  readonly verdict: string
  readonly reason: string | null
  readonly changed: boolean
  readonly skipped: boolean
}

try {
  const provider = await db.providers.getProvider(providerId)
  if (provider === null) {
    console.log(`Provider ${providerId}: NOT FOUND`)
    process.exit(0)
  }
  const providerDefault = provider.baseUrl
  const keys = await db.providers.listKeys(providerId)
  if (keys.length === 0) {
    console.log('No keys on this provider.')
    process.exit(0)
  }

  const outcomes: Outcome[] = []
  for (const key of keys) {
    const baseUrl = key.baseUrl ?? providerDefault
    if (baseUrl === null || baseUrl === undefined) {
      console.log(`${key.id}  SKIPPED (no base_url on key or provider)`)
      outcomes.push({
        id: key.id,
        previousHealth: key.health,
        newHealth: key.health,
        verdict: '—',
        reason: 'no base_url to probe',
        changed: false,
        skipped: true,
      })
      continue
    }

    let plaintext: string
    try {
      plaintext = await cipher.decrypt(key.encryptedKey)
    } catch (cause) {
      if (cause instanceof SecretCipherError) {
        console.log(`${key.id}  SKIPPED (cannot decrypt with this master key)`)
        outcomes.push({
          id: key.id,
          previousHealth: key.health,
          newHealth: key.health,
          verdict: '—',
          reason: 'stored key unreadable',
          changed: false,
          skipped: true,
        })
        continue
      }
      throw cause
    }

    const { verdict, reason } = await probe.test({ baseUrl, upstreamKey: plaintext })

    // Same mapping as `probedPatch`: only a disabled key refuses to move.
    const at = new Date()
    let patch: Record<string, unknown>
    if (key.health === 'disabled') {
      patch = { lastProbeAt: at, lastProbeVerdict: verdict, lastProbeReason: reason }
    } else if (verdict === 'usable') {
      patch = {
        health: 'active',
        healthReason: 'manual test confirmed usable',
        healthChangedAt: at,
        retryAfterAt: null,
        healthScope: 'key',
        healthScopeId: null,
        healthModel: null,
        lastProbeAt: at,
        lastProbeVerdict: verdict,
        lastProbeReason: reason,
      }
    } else if (verdict === 'rejected') {
      patch = {
        health: 'invalid_authentication',
        healthReason: reason ?? 'upstream rejected the test request',
        healthChangedAt: at,
        retryAfterAt: null,
        healthScope: 'key',
        healthScopeId: key.id,
        healthModel: null,
        lastProbeAt: at,
        lastProbeVerdict: verdict,
        lastProbeReason: reason,
      }
    } else {
      patch = {
        health: 'cooling_down',
        healthReason: reason ?? 'test could not reach the upstream',
        healthChangedAt: at,
        retryAfterAt: new Date(at.getTime() + 30_000),
        healthScope: 'key',
        healthScopeId: key.id,
        healthModel: null,
        lastProbeAt: at,
        lastProbeVerdict: verdict,
        lastProbeReason: reason,
      }
    }

    const newHealth = typeof patch.health === 'string' ? patch.health : key.health
    const changed = newHealth !== key.health || key.lastProbeVerdict !== verdict
    outcomes.push({
      id: key.id,
      previousHealth: key.health,
      newHealth,
      verdict,
      reason,
      changed,
      skipped: false,
    })

    console.log(`${key.id}  ${key.health} -> ${newHealth}  (verdict ${verdict})`)
    if (reason !== null) console.log(`    ${reason}`)

    if (!APPLY) continue

    await db.transaction(async (repositories) => {
      await repositories.providers.updateKey(key.id, patch as never, at)
      await repositories.audit.record({
        action: 'key.tested',
        outcome: verdict === 'usable' ? 'success' : 'failure',
        detail: {
          providerId,
          keyId: key.id,
          verdict,
          reason,
          previousHealth: key.health,
          newHealth,
        },
        at,
      })
    })
  }

  const probed = outcomes.filter((o) => !o.skipped)
  const changed = probed.filter((o) => o.changed)
  console.log('')
  console.log(
    `${probed.length} key(s) probed, ${changed.length} health state(s) would change, ` +
      `${outcomes.length - probed.length} skipped.`,
  )
  if (!APPLY && changed.length > 0) {
    console.log('Dry run. Pass --apply to write the changes.')
  }
} finally {
  await db.close()
}