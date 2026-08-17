/** Reconcile MiniMax key health from each key's authoritative entitlement. */
import { loadConfiguration } from '../src/config/environment.ts'
import { createSecretCipher } from '../src/crypto/index.ts'
import { openDatabase } from '../src/persistence/index.ts'
import { createBuiltInAdapterRegistry } from '../src/providers/adapter-registry.ts'
import {
  UsageService,
  createGenericUsageAdapter,
  createMinimaxUsageAdapter,
  recoveryEvidenceOf,
} from '../src/usage/index.ts'

const providerId = process.argv[2]
const apply = process.argv.includes('--apply')
const refreshOnly = process.argv.includes('--refresh-only')
if (!providerId) throw new Error('Usage: bun run scripts/reconcile-minimax-key-health.ts <provider-id> [--apply]')

const config = loadConfiguration()
const db = openDatabase(config.database)
const cipher = createSecretCipher(config.masterKey)
const adapter = createMinimaxUsageAdapter()

try {
  const provider = await db.providers.getProvider(providerId)
  if (!provider) throw new Error(`Provider not found: ${providerId}`)
  const keys = await db.providers.listKeys(providerId)
  const totals = { active: 0, exhausted: 0, unchanged: 0, failed: 0 }

  for (const key of refreshOnly ? [] : keys) {
    if (key.health === 'disabled') { totals.unchanged += 1; continue }
    const upstreamKey = await cipher.decrypt(key.encryptedKey)
    const result = await adapter.read({
      baseUrl: key.baseUrl ?? provider.baseUrl,
      allowInsecureHttp: provider.allowInsecureHttp,
      upstreamKey,
      signal: AbortSignal.timeout(20_000),
    })
    if (!result.ok || result.readings.length === 0) {
      totals.failed += 1
      console.log(`${key.id}: unchanged (${result.ok ? 'no reading' : result.failure.code})`)
      continue
    }

    const evidence = result.readings
      .map((reading) => recoveryEvidenceOf(reading, new Date()))
      .reduce((best, item) => item.hasCapacity ? item : best, recoveryEvidenceOf(result.readings[0]!, new Date()))
    const health = evidence.hasCapacity ? 'active' : 'exhausted'
    totals[health] += 1
    console.log(`${key.id}: ${key.health} -> ${health}`)
    if (!apply) continue

    const at = new Date()
    await db.providers.updateKey(key.id, {
      health,
      healthReason: health === 'active'
        ? 'authoritative MiniMax entitlement has capacity'
        : 'authoritative MiniMax entitlement is exhausted',
      healthChangedAt: at,
      retryAfterAt: health === 'exhausted' ? evidence.resetAt : null,
      healthScope: 'key',
      healthScopeId: health === 'exhausted' ? key.id : null,
      healthModel: health === 'exhausted' ? 'general' : null,
    }, at)
  }
  if (!refreshOnly) console.log(JSON.stringify({ apply, keys: keys.length, ...totals }))

  if (apply || refreshOnly) {
    const usage = new UsageService({
      database: db,
      cipher,
      adapter: createGenericUsageAdapter(),
      adapterRegistry: createBuiltInAdapterRegistry(),
    })
    const refreshed = await usage.refresh(providerId)
    if (!refreshed.ok) throw new Error(`Usage refresh failed: ${refreshed.failure.code}`)
    const percentages = refreshed.value.readings
      .map((reading) => reading.remainingPercent)
      .filter((value): value is number => value !== null)
    console.log(JSON.stringify({
      usageSnapshot: 'refreshed',
      readings: refreshed.value.readings.length,
      zeroPercent: percentages.filter((value) => value === 0).length,
      positivePercent: percentages.filter((value) => value > 0).length,
    }))
  }
} finally {
  await db.close()
}
