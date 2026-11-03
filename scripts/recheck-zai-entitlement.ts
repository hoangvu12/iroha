/**
 * Re-checks every Upstream Key on the z.ai provider against the Zhipu
 * entitlement API (`/api/monitor/usage/quota/limit`) and updates each key's
 * credential evidence accordingly.
 *
 * Keys with valid entitlement (subscription or pay-as-you-go credit) stay
 * or become active. Keys the entitlement endpoint rejects get marked as
 * invalid_authentication.
 *
 * Usage:
 *   bun run scripts/recheck-zai-entitlement.ts [--apply]
 */
import { loadConfiguration } from '../src/config/environment.ts'
import { openDatabase } from '../src/persistence/index.ts'
import { createSecretCipher, SecretCipherError } from '../src/crypto/index.ts'
import { zaiUsageReadings } from '../src/usage/zai-usage-adapter.ts'

const APPLY = process.argv.includes('--apply')
const ZAI_PROVIDER_HANDLE = 'z-ai'
const PROBE_TIMEOUT_MS = 10_000
const BATCH_SIZE = 10

function entitlementHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase().endsWith('bigmodel.cn')
      ? 'https://open.bigmodel.cn'
      : 'https://api.z.ai'
  } catch {
    return 'https://api.z.ai'
  }
}

async function main(): Promise<void> {
  const config = loadConfiguration()
  const db = openDatabase(config.database)
  const cipher = createSecretCipher(config.masterKey)

  try {
    const provider = await db.providers.getProviderByHandle(ZAI_PROVIDER_HANDLE)
    if (provider === null) {
      console.error(`Provider "${ZAI_PROVIDER_HANDLE}" not found.`)
      process.exit(1)
    }
    const providerId = provider.id
    console.log(`Provider: ${provider.displayName} (${providerId}), baseUrl: ${provider.baseUrl}`)

    const keys = await db.providers.listKeys(providerId)
    console.log(`Found ${keys.length} keys to re-check.`)

    type Outcome = {
      keyId: string
      plaintext: string
      effectiveBaseUrl: string
      previousHealth: string
      newHealth: string
      verdict: 'authenticated' | 'rejected' | 'inconclusive'
      reason: string
      subscription?: { remainingPercent: number; resetAt: string | null }
    }

    const outcomes: Outcome[] = []

    for (let i = 0; i < keys.length; i += BATCH_SIZE) {
      const batch = keys.slice(i, i + BATCH_SIZE)
      const batchResults = await Promise.all(
        batch.map(async (key) => {
          let plaintext: string
          try {
            plaintext = await cipher.decrypt(key.encryptedKey)
          } catch {
            return { keyId: key.id, plaintext: '', effectiveBaseUrl: '', previousHealth: key.health, newHealth: key.health, verdict: 'inconclusive' as const, reason: 'cannot decrypt' }
          }

          const effectiveBaseUrl = key.baseUrl ?? provider.baseUrl
          const host = entitlementHost(effectiveBaseUrl)
          const quotaUrl = `${host}/api/monitor/usage/quota/limit`

          let response: Response
          try {
            response = await fetch(quotaUrl, {
              method: 'GET',
              headers: { authorization: `Bearer ${plaintext}`, accept: 'application/json' },
              redirect: 'manual',
              signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
            })
          } catch {
            return { keyId: key.id, plaintext, effectiveBaseUrl, previousHealth: key.health, newHealth: key.health, verdict: 'inconclusive' as const, reason: 'entitlement API unreachable' }
          }

          const { status } = response
          let body: unknown
          try { body = await response.json() } catch { body = null }

          if (status === 401 || status === 403) {
            return { keyId: key.id, plaintext, effectiveBaseUrl, previousHealth: key.health, newHealth: 'invalid_authentication', verdict: 'rejected' as const, reason: `HTTP ${status}` }
          }

          const parsed = body as Record<string, unknown> | null
          if (!parsed || typeof parsed !== 'object') {
            return { keyId: key.id, plaintext, effectiveBaseUrl, previousHealth: key.health, newHealth: key.health, verdict: 'inconclusive' as const, reason: 'unparseable response' }
          }

          const authCode = parsed.code
          if (authCode === 1000 || authCode === 1001) {
            return { keyId: key.id, plaintext, effectiveBaseUrl, previousHealth: key.health, newHealth: 'invalid_authentication', verdict: 'rejected' as const, reason: `auth code ${authCode}` }
          }

          const readings = zaiUsageReadings(body)
          if (readings.length > 0) {
            const r = readings[0]
            return {
              keyId: key.id, plaintext, effectiveBaseUrl,
              previousHealth: key.health, newHealth: 'active',
              verdict: 'authenticated' as const,
              reason: `subscription: ${r.remainingPercent}% remaining, resets ${r.resetAt?.toISOString().slice(0, 10) ?? '?'}`,
              subscription: { remainingPercent: r.remainingPercent, resetAt: r.resetAt?.toISOString() ?? null },
            }
          }

          if (parsed.success === false && authCode === 500) {
            return {
              keyId: key.id, plaintext, effectiveBaseUrl,
              previousHealth: key.health, newHealth: 'exhausted',
              verdict: 'inconclusive' as const,
              reason: 'no subscription (credit cannot be confirmed via entitlement API)',
            }
          }

          return {
            keyId: key.id, plaintext, effectiveBaseUrl,
            previousHealth: key.health, newHealth: 'active',
            verdict: 'authenticated' as const,
            reason: `recognised (code ${authCode ?? status})`,
          }
        }),
      )

      for (const r of batchResults) {
        outcomes.push(r as Outcome)
      }

      if ((i + BATCH_SIZE) % 100 === 0 || i + BATCH_SIZE >= keys.length) {
        console.log(`  Progress: ${Math.min(i + BATCH_SIZE, keys.length)}/${keys.length}`)
      }
    }

    const authenticated = outcomes.filter((o) => o.verdict === 'authenticated')
    const rejected = outcomes.filter((o) => o.verdict === 'rejected')
    const inconclusive = outcomes.filter((o) => o.verdict === 'inconclusive')
    const subscription = outcomes.filter((o) => o.subscription !== undefined)

    console.log(`\n=== RESULTS ===`)
    console.log(`  Authenticated:     ${authenticated.length}`)
    console.log(`  With subscription: ${subscription.length}`)
    console.log(`  Rejected:          ${rejected.length}`)
    console.log(`  Inconclusive:      ${inconclusive.length}`)

    if (!APPLY) {
      console.log('\nDry run. Would update:')
      for (const o of outcomes) {
        if (o.newHealth !== o.previousHealth) {
          console.log(`  ${o.keyId.slice(0, 30)}...  ${o.previousHealth} -> ${o.newHealth}  (${o.reason})`)
        }
      }
      console.log(`\n${outcomes.filter((o) => o.newHealth !== o.previousHealth).length} key(s) would change health.`)
      console.log('Pass --apply to write.')
      return
    }

    console.log('\nUpdating key health...')
    let changed = 0
    let unchanged = 0

    for (const o of outcomes) {
      if (o.newHealth === o.previousHealth) {
        unchanged += 1
        continue
      }

      const at = new Date()
      await db.transaction(async (repositories) => {
        await repositories.providers.updateKey(o.keyId, {
          health: o.newHealth,
          healthReason: o.reason,
          healthChangedAt: at,
          lastProbeAt: at,
          lastProbeVerdict: o.verdict,
          lastProbeReason: o.reason,
          retryAfterAt: null,
          healthScope: 'key',
          healthScopeId: null,
          healthModel: null,
        } as never, at)
        await repositories.audit.record({
          action: o.newHealth === 'invalid_authentication' ? 'key.tested' : 'key.activated',
          outcome: o.verdict === 'authenticated' ? 'success' : 'failure',
          detail: { providerId, keyId: o.keyId, source: 'recheck-zai-entitlement', verdict: o.verdict, reason: o.reason, from: o.previousHealth, to: o.newHealth },
          at,
        })
      })

      changed += 1
    }

    console.log(`  ${changed} key(s) health updated, ${unchanged} unchanged.`)

    const finalHealth = new Map<string, number>()
    for (const o of outcomes) finalHealth.set(o.newHealth, (finalHealth.get(o.newHealth) ?? 0) + 1)
    console.log('  Final health breakdown:')
    for (const [h, c] of finalHealth) console.log(`    ${h}: ${c}`)

  } finally {
    await db.close()
  }
}

await main()