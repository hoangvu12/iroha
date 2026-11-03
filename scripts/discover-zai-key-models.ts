/**
 * Discovers which models each active z.ai key can access by calling
 * `GET /models` on each key's effective base URL, then stores the
 * results in the `key_model_availability` table and ensures the model
 * catalog has all models.
 *
 * Usage:
 *   bun run scripts/discover-zai-key-models.ts [--apply]
 */
import { loadConfiguration } from '../src/config/environment.ts'
import { openDatabase } from '../src/persistence/index.ts'
import { createSecretCipher } from '../src/crypto/index.ts'

const APPLY = process.argv.includes('--apply')
const ZAI_PROVIDER_HANDLE = 'z-ai'
const PROBE_TIMEOUT_MS = 15_000
const BATCH_SIZE = 5

async function main(): Promise<void> {
  const config = loadConfiguration()
  const db = openDatabase(config.database)
  const cipher = createSecretCipher(config.masterKey)

  try {
    const provider = await db.providers.getProviderByHandle(ZAI_PROVIDER_HANDLE)
    if (provider === null) { console.error('Provider not found.'); process.exit(1) }
    const providerId = provider.id

    const keys = await db.providers.listKeys(providerId)
    const activeKeys = keys.filter((k) => k.health === 'active' || k.health === 'unverified')
    console.log(`${activeKeys.length} active/unverified keys to discover.`)

    interface Discovery {
      keyId: string
      models: string[]
      error?: string
    }

    const discoveries: Discovery[] = []

    for (let i = 0; i < activeKeys.length; i += BATCH_SIZE) {
      const batch = activeKeys.slice(i, i + BATCH_SIZE)
      const results = await Promise.all(
        batch.map(async (key) => {
          let plaintext: string
          try { plaintext = await cipher.decrypt(key.encryptedKey) }
          catch { return { keyId: key.id, models: [], error: 'cannot decrypt' } }

          const baseUrl = key.baseUrl ?? provider.baseUrl
          const modelsUrl = baseUrl.endsWith('/') ? `${baseUrl}models` : `${baseUrl}/models`

          let response: Response
          try {
            response = await fetch(modelsUrl, {
              method: 'GET',
              headers: { authorization: `Bearer ${plaintext}`, accept: 'application/json' },
              redirect: 'manual',
              signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
            })
          } catch {
            return { keyId: key.id, models: [], error: 'unreachable' }
          }

          if (!response.ok) {
            void response.body?.cancel().catch(() => undefined)
            return { keyId: key.id, models: [], error: `HTTP ${response.status}` }
          }

          let body: unknown
          try { body = await response.json() }
          catch { return { keyId: key.id, models: [], error: 'unparseable' } }

          const parsed = body as { data?: { id?: unknown }[] }
          if (!parsed?.data || !Array.isArray(parsed.data)) {
            return { keyId: key.id, models: [], error: 'unexpected shape' }
          }

          const models: string[] = []
          for (const entry of parsed.data) {
            if (typeof entry?.id === 'string') models.push(entry.id)
          }
          return { keyId: key.id, models, error: models.length === 0 ? 'empty model list' : undefined }
        }),
      )

      for (const r of results) discoveries.push(r)
      if ((i + BATCH_SIZE) % 100 === 0 || i + BATCH_SIZE >= activeKeys.length) {
        console.log(`  Progress: ${Math.min(i + BATCH_SIZE, activeKeys.length)}/${activeKeys.length}`)
      }
    }

    const withModels = discoveries.filter((d) => d.models.length > 0 && !d.error)
    const noModels = discoveries.filter((d) => d.error)
    const union = [...new Set(withModels.flatMap((d) => d.models))].sort()

    console.log(`\n=== RESULTS ===`)
    console.log(`  Keys with models:  ${withModels.length}`)
    console.log(`  Keys with errors:  ${noModels.length}`)
    console.log(`  Model union:       ${union.length} models`)

    if (union.length > 0) {
      console.log('  Models discovered:')
      for (const m of union) console.log(`    ${m}`)
    }

    if (!APPLY) {
      console.log('\nDry run. Summary per key:')
      for (const d of discoveries) {
        const tag = d.error ? `ERROR: ${d.error}` : `${d.models.length} models`
        console.log(`  ${d.keyId.slice(0, 30)}...  ${tag}`)
      }
      console.log(`\n${withModels.length} key(s) would get model availability written.`)
      console.log('Pass --apply to write.')
      return
    }

    console.log('\nWriting key model availability...')
    const at = new Date()
    const metadataByModel: Record<string, { chat?: string; contextLength?: number; maxOutputTokens?: number }> = {}

    for (const d of withModels) {
      await db.keyModelAvailability.put({
        keyId: d.keyId,
        providerId,
        models: d.models,
        discoveredAt: at,
      })
    }

    await db.modelCatalog.syncDiscovered(providerId, union, at, metadataByModel)

    console.log(`  ${withModels.length} key(s) updated.`)
    console.log(`  Model catalog synced with ${union.length} models.`)

    const after = await db.keyModelAvailability.listForProvider(providerId)
    console.log(`  Total availability entries: ${after.length}`)

  } finally {
    await db.close()
  }
}

await main()