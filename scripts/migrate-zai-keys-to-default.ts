/**
 * Migrates z.ai keys on non-default base URLs to the provider default
 * (`https://api.z.ai/api/coding/paas/v4`) when they work there too.
 *
 * Keys confirmed to work on default:
 *   - All /anthropic and api.z.ai/v1 keys → migrate to default
 *   - /coding keys that also work on /coding/paas/v4 → migrate to default
 *   - /coding keys that ONLY work on /coding → keep their /coding base_url
 *
 * After migration, re-discovers key model availability.
 *
 * Usage:
 *   bun run scripts/migrate-zai-keys-to-default.ts [--apply]
 */
import { loadConfiguration } from '../src/config/environment.ts'
import { openDatabase } from '../src/persistence/index.ts'
import { createSecretCipher } from '../src/crypto/index.ts'

const APPLY = process.argv.includes('--apply')
const ZAI_HANDLE = 'z-ai'

async function main(): Promise<void> {
  const config = loadConfiguration()
  const db = openDatabase(config.database)
  const cipher = createSecretCipher(config.masterKey)

  try {
    const provider = await db.providers.getProviderByHandle(ZAI_HANDLE)
    if (!provider) { console.error('Provider not found'); process.exit(1) }

    const keys = await db.providers.listKeys(provider.id)
    const active = keys.filter(k => k.health === 'active' && k.baseUrl !== null)
    console.log(`Found ${active.length} active keys with non-default base URLs.`)

    interface Plan {
      keyId: string
      oldBaseUrl: string
      action: 'migrate' | 'keep'
      reason: string
    }

    const plan: Plan[] = []

    for (const key of active) {
      const b = key.baseUrl!
      let pt: string
      try { pt = await cipher.decrypt(key.encryptedKey) } catch { continue }

      const probeUrl = (base: string) => {
        const u = base.endsWith('/') ? base + 'models' : base + '/models'
        return fetch(u, { method:'GET', headers:{authorization:'Bearer '+pt}, redirect:'manual', signal:AbortSignal.timeout(10000) })
          .then(r => { r.body?.cancel().catch(()=>{}); return r.status })
          .catch(() => 'err')
      }

      const onDefault = await probeUrl(provider.baseUrl)
      const onOriginal = await probeUrl(b)

      if (b.includes('/anthropic') || b === 'https://api.z.ai/v1') {
        if (onDefault === 200) {
          plan.push({ keyId: key.id, oldBaseUrl: b, action: 'migrate', reason: 'works on default' })
        } else {
          plan.push({ keyId: key.id, oldBaseUrl: b, action: 'keep', reason: `default=${onDefault}` })
        }
      } else if (b.includes('/coding') && !b.includes('/paas/v4')) {
        if (onDefault === 200 && onOriginal === 200) {
          plan.push({ keyId: key.id, oldBaseUrl: b, action: 'migrate', reason: 'works on both' })
        } else {
          plan.push({ keyId: key.id, oldBaseUrl: b, action: 'keep', reason: `coding=${onOriginal} default=${onDefault}` })
        }
      } else {
        plan.push({ keyId: key.id, oldBaseUrl: b, action: 'keep', reason: 'non-standard endpoint' })
      }
    }

    const toMigrate = plan.filter(p => p.action === 'migrate')
    const toKeep = plan.filter(p => p.action === 'keep')

    console.log(`  Migrate to default: ${toMigrate.length}`)
    console.log(`  Keep original:      ${toKeep.length}`)

    for (const p of toMigrate) {
      console.log(`  MIGRATE ${p.keyId.slice(0,30)}...  ${p.oldBaseUrl}  →  (default)  (${p.reason})`)
    }
    for (const p of toKeep) {
      console.log(`  KEEP    ${p.keyId.slice(0,30)}...  ${p.oldBaseUrl}  (${p.reason})`)
    }

    if (!APPLY) {
      console.log(`\n${toMigrate.length} key(s) would be migrated. Pass --apply to write.`)
      return
    }

    console.log('\nWriting migrations...')
    const at = new Date()
    for (const p of toMigrate) {
      await db.providers.updateKey(p.keyId, { baseUrl: null }, at)
    }
    console.log(`  ${toMigrate.length} key(s) updated to inherit default base URL.`)

    const modelKeys = await db.providers.listKeys(provider.id)
    const activeKeys = modelKeys.filter(k => k.health === 'active')
    const discovered = await db.keyModelAvailability.listForProvider(provider.id)
    const discoveredIds = new Set(discovered.map(d => d.keyId))
    const undiscovered = activeKeys.filter(k => !discoveredIds.has(k.id))

    if (undiscovered.length > 0) {
      console.log(`\nDiscovering models for ${undiscovered.length} newly migrated key(s)...`)
      const meta: Record<string, Record<string, unknown>> = {}
      for (const key of undiscovered) {
        let pt: string
        try { pt = await cipher.decrypt(key.encryptedKey) } catch { continue }
        const base = key.baseUrl ?? provider.baseUrl
        const u = base.endsWith('/') ? base + 'models' : base + '/models'
        let body: unknown
        try {
          const r = await fetch(u, { method:'GET', headers:{authorization:'Bearer '+pt}, redirect:'manual', signal:AbortSignal.timeout(10000) })
          if (r.ok) body = await r.json()
          r.body?.cancel().catch(()=>{})
        } catch { continue }
        if (!body) continue
        const parsed = body as { data?: { id?: unknown }[] }
        if (!parsed?.data) continue
        const models = parsed.data.filter(e => typeof e?.id === 'string').map(e => e.id as string)
        if (models.length === 0) continue
        await db.keyModelAvailability.put({ keyId: key.id, providerId: provider.id, models, discoveredAt: at })
        for (const m of models) { meta[m] ??= {} }
      }
      const all = await db.keyModelAvailability.listForProvider(provider.id)
      const union = [...new Set(all.flatMap(e => e.models))].sort()
      await db.modelCatalog.syncDiscovered(provider.id, union, at, meta as never)
      console.log(`  ${undiscovered.length} key(s) discovered, ${union.length} models in catalog.`)
    } else {
      console.log('  No undiscovered keys remain.')
    }

    const final = await db.providers.listKeys(provider.id)
    const inherited = final.filter(k => k.baseUrl === null)
    const overridden = final.filter(k => k.baseUrl !== null)
    console.log(`\nFinal: ${inherited.length} keys inherit default, ${overridden.length} have URL overrides.`)

  } finally {
    await db.close()
  }
}

await main()