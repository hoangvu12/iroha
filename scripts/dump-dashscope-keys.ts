/**
 * TEMP dump (session 3 key hunt): decrypt every Upstream Key whose plaintext
 * looks like a DashScope key and write it — with its provider and health — to
 * ../dashscope/iroha_dev_keys.json so the hunter can re-verify keys that sit in
 * iroha but were lost from the local pool.
 *
 * Read-only. Delete after use.
 */
import { loadConfiguration } from '../src/config/environment.ts'
import { createSecretCipher } from '../src/crypto/index.ts'
import { openDatabase } from '../src/persistence/index.ts'

const RX = /^sk-(?:sp|tok|ws)-[A-Za-z0-9._-]{18,}$|^sk-[0-9a-fA-F]{32,64}$/
const OUT = 'C:/Users/ADMIN/Desktop/nguyenvu/dashscope/iroha_dev_keys.json'

const config = loadConfiguration()
const database = openDatabase(config.database)
const cipher = createSecretCipher(config.masterKey)

const providers = await database.providers.listProviders()
const rows: Record<string, unknown>[] = []
for (const provider of providers) {
  const keys = await database.providers.listKeys(provider.id)
  for (const key of keys) {
    let plaintext: string
    try {
      plaintext = await cipher.decrypt(key.encryptedKey)
    } catch {
      continue
    }
    if (!RX.test(plaintext)) continue
    rows.push({
      provider: provider.handle ?? provider.id,
      providerId: provider.id,
      key: plaintext,
      health: key.health,
      reason: key.healthReason ?? null,
      baseUrl: key.baseUrl ?? provider.baseUrl,
      createdAt: key.createdAt.toISOString(),
    })
  }
}
await Bun.write(OUT, JSON.stringify({ source: 'iroha-dev-dump', keys: rows }, null, 1))
console.log(`dumped ${rows.length} dashscope-shaped keys -> ${OUT}`)
const counts = new Map<string, number>()
for (const row of rows) {
  const label = `${String(row.provider)}/${String(row.health)}`
  counts.set(label, (counts.get(label) ?? 0) + 1)
}
console.log([...counts].map(([k, v]) => `${k}=${v}`).join(' '))