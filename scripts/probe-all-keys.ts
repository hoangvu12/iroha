/**
 * One-shot diagnostic: probe EVERY key on a provider against its own base_url
 * and compare against the stored health. Reports status codes so the Owner can
 * see which keys actually authenticate vs which are just marked active.
 *
 * Usage:
 *   bun run scripts/probe-all-keys.ts <provider-id>
 */
import { loadConfiguration } from '../src/config/environment.ts'
import { openDatabase } from '../src/persistence/index.ts'
import { createSecretCipher } from '../src/crypto/index.ts'

const providerId = process.argv[2]
if (!providerId) {
  console.error('Usage: bun run scripts/probe-all-keys.ts <provider-id>')
  process.exit(1)
}

const config = loadConfiguration()
const db = openDatabase(config.database)
const cipher = createSecretCipher(config.masterKey)

const TIMEOUT_MS = 10_000

function modelUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl.endsWith('/') ? `${baseUrl}models` : `${baseUrl}/models`).href
  } catch {
    return `INVALID URL: ${baseUrl}`
  }
}

try {
  const provider = await db.providers.getProvider(providerId)
  if (provider === null) {
    console.log(`Provider ${providerId}: NOT FOUND`)
    process.exit(0)
  }
  console.log(`Provider: ${provider.displayName} (${provider.id})`)
  console.log(`Provider base_url: ${provider.baseUrl ?? '(none)'}`)
  console.log('')

  const keys = await db.providers.listKeys(providerId)
  if (keys.length === 0) {
    console.log('No keys on this provider.')
    process.exit(0)
  }

  for (const key of keys) {
    const baseUrl = key.baseUrl ?? provider.baseUrl
    if (baseUrl === null || baseUrl === undefined) {
      console.log(`${key.id}  SKIPPED (no base_url on key or provider)`)
      continue
    }

    let decrypted: string
    try {
      decrypted = await cipher.decrypt(key.encryptedKey)
    } catch {
      console.log(`${key.id}  DECRYPT-FAILED  (stored ${key.health})`)
      continue
    }

    const masked = `${decrypted.slice(0, 4)}…${decrypted.slice(-4)} (len ${decrypted.length})`
    const url = modelUrl(baseUrl)

    let outcome = 'error'
    let detail = 'could not be reached'
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${decrypted}`, accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      void response.body?.cancel().catch(() => undefined)
      outcome = `HTTP ${response.status}`
      if (response.status >= 200 && response.status < 300) detail = 'usable'
      else if (response.status === 401) detail = 'rejected key'
      else if (response.status === 403) detail = 'refused models endpoint'
      else if (response.status === 404) detail = 'no models endpoint'
      else if (response.status === 429) detail = 'rate-limited'
      else if (response.status >= 300 && response.status < 400) detail = 'redirect'
      else detail = 'unknown'
    } catch (error) {
      const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : ''
      if (name === 'TimeoutError' || name === 'AbortError') {
        outcome = 'timeout'
        detail = `no answer within ${TIMEOUT_MS}ms`
      } else {
        outcome = 'network-error'
        detail = String(error)
      }
    }

    const lastProbe =
      key.lastProbeAt === null
        ? 'never'
        : key.lastProbeAt.toISOString().slice(0, 19).replace('T', ' ')
    const verdict = key.lastProbeVerdict ?? '—'

    console.log(`${key.id}`)
    console.log(`  stored health : ${key.health}   (last probe ${lastProbe}, verdict ${verdict})`)
    console.log(`  reason        : ${key.lastProbeReason ?? key.healthReason ?? '—'}`)
    console.log(`  base_url      : ${baseUrl}`)
    console.log(`  key           : ${masked}`)
    console.log(`  probe ${url}`)
    console.log(`  => ${outcome}  (${detail})`)
    console.log('')
  }
} finally {
  await db.close()
}