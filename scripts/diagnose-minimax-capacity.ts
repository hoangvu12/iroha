/** Compare MiniMax's legacy/new entitlement responses with real model calls. */
import { loadConfiguration } from '../src/config/environment.ts'
import { createSecretCipher } from '../src/crypto/index.ts'
import { openDatabase } from '../src/persistence/index.ts'

const providerId = process.argv[2]
if (!providerId) throw new Error('Usage: bun run scripts/diagnose-minimax-capacity.ts <provider-id>')

const config = loadConfiguration()
const db = openDatabase(config.database)
const cipher = createSecretCipher(config.masterKey)

function summarize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(summarize)
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (/key|token|authorization/i.test(key)) continue
    output[key] = summarize(item)
  }
  return output
}

async function request(url: string, upstreamKey: string, init: RequestInit = {}) {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${upstreamKey}`, accept: 'application/json', ...init.headers },
    })
    const text = await response.text()
    let body: unknown = text.slice(0, 1_000)
    try { body = JSON.parse(text) } catch { /* retain truncated text */ }
    return { status: response.status, body: summarize(body) }
  } catch (error) {
    return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
  }
}

try {
  const provider = await db.providers.getProvider(providerId)
  if (!provider) throw new Error(`Provider not found: ${providerId}`)
  const keys = await db.providers.listKeys(providerId)
  const samples = [
    ...keys.filter((key) => key.health === 'active').slice(0, 2),
    ...keys.filter((key) => key.health === 'exhausted').slice(0, 5),
  ]

  for (const [index, key] of samples.entries()) {
    const upstreamKey = await cipher.decrypt(key.encryptedKey)
    const baseUrl = (key.baseUrl ?? provider.baseUrl).replace(/\/$/, '')
    const hostname = new URL(baseUrl).hostname
    const platform = hostname.endsWith('minimaxi.com') ? 'https://www.minimaxi.com' : 'https://api.minimax.io'
    const referer = hostname.endsWith('minimaxi.com') ? 'https://platform.minimaxi.com/' : 'https://platform.minimax.io/'
    console.log(JSON.stringify({ sample: index + 1, health: key.health, endpoint: hostname }))
    console.log('legacy', JSON.stringify(await request(`${platform}/v1/api/openplatform/coding_plan/remains`, upstreamKey, { headers: { referer } })))
    console.log('documented', JSON.stringify(await request(`${platform}/v1/token_plan/remains`, upstreamKey, { headers: { referer } })))
    for (const model of ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5']) {
      const result = await request(`${baseUrl}/chat/completions`, upstreamKey, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply only: OK' }], max_tokens: 4 }),
      })
      console.log(model, JSON.stringify(result))
    }
  }
} finally {
  await db.close()
}
