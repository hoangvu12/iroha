/**
 * One-shot diagnostic: call the MiniMax entitlement endpoint directly with the
 * stored key and print the raw JSON response. Bypasses the adapter's parsing
 * so we can see exactly what MiniMax returns and decide whether model names
 * are present in a field we don't yet read.
 *
 * Usage:
 *   bun run scripts/probe-minimax.ts <provider-id>
 */
import { loadConfiguration } from '../src/config/environment.ts'
import { openDatabase } from '../src/persistence/index.ts'
import { createSecretCipher } from '../src/crypto/index.ts'

const providerId = process.argv[2]
if (!providerId) {
  console.error('Usage: bun run scripts/probe-minimax.ts <provider-id>')
  process.exit(1)
}

const config = loadConfiguration()
const db = openDatabase(config.database)
const cipher = createSecretCipher(config.masterKey)

try {
  const provider = await db.providers.getProvider(providerId)
  if (provider === null) {
    console.log(`Provider ${providerId}: NOT FOUND`)
    process.exit(0)
  }
  const baseUrl = new URL(provider.baseUrl)
  const host = baseUrl.hostname.toLowerCase()
  const entitlementHost = host.endsWith('.minimaxi.com') || host === 'www.minimaxi.com'
    ? 'https://www.minimaxi.com'
    : host === 'api.minimax.chat' || host.endsWith('.minimax.chat')
      ? 'https://api.minimax.chat'
      : 'https://api.minimax.io'
  const referer = host.endsWith('.minimaxi.com') || host === 'www.minimaxi.com'
    ? 'https://platform.minimaxi.com/'
    : 'https://platform.minimax.io/'

  const keys = await db.providers.listKeys(providerId)
  const eligible = keys.find((k) => k.health === 'active' || k.health === 'unverified') ?? keys[0]
  if (eligible === undefined) {
    console.log('No keys on this provider.')
    process.exit(0)
  }
  const upstreamKey = await cipher.decrypt(eligible.encryptedKey)
  const maskedKey = `${upstreamKey.slice(0, 4)}…${upstreamKey.slice(-4)} (length ${upstreamKey.length})`

  console.log(`Calling ${entitlementHost}/v1/api/openplatform/coding_plan/remains`)
  console.log(`Referer: ${referer}`)
  console.log(`Key: ${maskedKey}`)

  const response = await fetch(`${entitlementHost}/v1/api/openplatform/coding_plan/remains`, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${upstreamKey}`,
      referer,
      accept: 'application/json',
    },
  })

  console.log(`\n=== HTTP ${response.status} ===`)
  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  console.log(JSON.stringify(body, null, 2))
} finally {
  await db.close()
}