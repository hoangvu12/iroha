/** Probe selected DashScope keys with a minimal chat request; never prints secrets. */
import { loadConfiguration } from '../src/config/environment.ts'
import { createSecretCipher } from '../src/crypto/index.ts'
import { openDatabase } from '../src/persistence/index.ts'

const providerId = process.argv[2]
const keyIds = process.argv.slice(3)
if (!providerId || keyIds.length === 0) throw new Error('Usage: bun run scripts/probe-dashscope-keys.ts <provider-id> <key-id>...')
const config = loadConfiguration()
const db = openDatabase(config.database)
const cipher = createSecretCipher(config.masterKey)
try {
  const provider = await db.providers.getProvider(providerId)
  if (!provider) throw new Error(`Provider not found: ${providerId}`)
  const keys = await db.providers.listKeys(providerId)
  for (const keyId of keyIds) {
    const key = keys.find((candidate) => candidate.id === keyId)
    if (!key) { console.log(JSON.stringify({ keyId, error: 'not_found' })); continue }
    const baseUrl = (key.baseUrl ?? provider.baseUrl).replace(/\/$/, '')
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await cipher.decrypt(key.encryptedKey)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'qwen3.7-plus',
        messages: [{ role: 'user', content: 'Call the echo tool with value OK.' }],
        max_tokens: 8,
        stream: true,
        stream_options: { include_usage: true },
        tools: [{
          type: 'function',
          function: {
            name: 'echo',
            description: 'Echo a value.',
            parameters: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
              additionalProperties: false,
            },
          },
        }],
      }),
      signal: AbortSignal.timeout(30_000),
    })
    const text = await response.text()
    let error: unknown = null
    if (!response.ok) {
      try { error = JSON.parse(text) } catch { error = text.slice(0, 500) }
    }
    console.log(JSON.stringify({ keyId, host: new URL(baseUrl).host, status: response.status, error }))
  }
} finally {
  await db.close()
}
