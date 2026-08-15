/**
 * Read-only database diagnostic for a Provider's Upstream Keys.
 *
 * It deliberately does not call the upstream and never prints plaintext keys.
 * A short SHA-256 fingerprint is computed after decryption only to identify
 * duplicate stored credentials within this Provider.
 *
 * Pass --live-inference to verify each key with a minimal chat completion.
 * This opt-in mode calls the upstream and may consume a tiny amount of quota.
 *
 * Usage:
 *   bun run scripts/diagnose-provider-keys.ts <provider-id>
 *   bun run scripts/diagnose-provider-keys.ts <provider-id> --live-inference --model qwen-turbo
 *   bun run scripts/diagnose-provider-keys.ts <provider-id> --live-inference --base-url https://example/v1
 */
import { createHash } from 'node:crypto'
import { loadConfiguration } from '../src/config/environment.ts'
import { createSecretCipher } from '../src/crypto/index.ts'
import { openDatabase } from '../src/persistence/index.ts'

const providerId = process.argv[2]
if (!providerId) {
  console.error('Usage: bun run scripts/diagnose-provider-keys.ts <provider-id>')
  process.exit(1)
}

const liveInference = process.argv.includes('--live-inference')
const modelFlag = process.argv.indexOf('--model')
const inferenceModel = modelFlag === -1 ? 'qwen-turbo' : process.argv[modelFlag + 1]
const baseUrlFlag = process.argv.indexOf('--base-url')
const liveBaseUrl = baseUrlFlag === -1 ? undefined : process.argv[baseUrlFlag + 1]
if (liveInference && !inferenceModel) {
  console.error('--model requires an exact upstream model ID')
  process.exit(1)
}
if (baseUrlFlag !== -1 && !liveBaseUrl) {
  console.error('--base-url requires a URL')
  process.exit(1)
}

const config = loadConfiguration()
const database = openDatabase(config.database)
const cipher = createSecretCipher(config.masterKey)

function iso(value: Date | null): string {
  return value === null ? 'never' : value.toISOString()
}

function safeUrl(value: string | null): string {
  if (value === null) return '(none)'
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    return '(invalid URL)'
  }
}

function detailOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

try {
  const provider = await database.providers.getProvider(providerId)
  if (provider === null) {
    console.error(`Provider ${providerId}: NOT FOUND`)
    process.exitCode = 2
  } else {
    const keys = await database.providers.listKeys(providerId)
    const keyIds = new Set(keys.map((key) => key.id))
    const audit = (await database.audit.list({ limit: 100_000 }))
      .filter((event) => {
        const detail = detailOf(event.detail)
        return detail?.providerId === providerId ||
          (typeof detail?.keyId === 'string' && keyIds.has(detail.keyId))
      })
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())

    const fingerprints = new Map<string, string[]>()
    const rows = []
    for (const key of keys) {
      let secretShape = 'unreadable'
      try {
        const plaintext = await cipher.decrypt(key.encryptedKey)
        const fingerprint = createHash('sha256').update(plaintext).digest('hex').slice(0, 12)
        secretShape = `len=${plaintext.length}, sha256=${fingerprint}`
        fingerprints.set(fingerprint, [...(fingerprints.get(fingerprint) ?? []), key.id])
      } catch {
        // The failure itself is diagnostic; never include cipher error details.
      }

      const keyAudit = audit.filter((event) => detailOf(event.detail)?.keyId === key.id)
      const created = keyAudit.find((event) => event.action === 'key.created') ?? null
      const latestTest = [...keyAudit].reverse().find((event) => event.action === 'key.tested') ?? null
      rows.push({
        id: key.id,
        health: key.health,
        created: iso(key.createdAt),
        healthChanged: iso(key.healthChangedAt),
        lastProbe: iso(key.lastProbeAt),
        verdict: key.lastProbeVerdict ?? 'none',
        reason: key.lastProbeReason ?? key.healthReason ?? 'none',
        baseUrl: safeUrl(key.baseUrl ?? provider.baseUrl),
        secretShape,
        createAudit: created === null ? 'missing' : `${created.outcome} @ ${iso(created.occurredAt)}`,
        latestTestAudit: latestTest === null
          ? 'missing'
          : `${latestTest.outcome} @ ${iso(latestTest.occurredAt)}`,
      })
    }

    const counts = new Map<string, number>()
    for (const key of keys) counts.set(key.health, (counts.get(key.health) ?? 0) + 1)

    console.log(`Provider: ${provider.displayName} (${provider.id})`)
    console.log(`Database: ${config.database.describe}`)
    console.log(`Provider base URL: ${safeUrl(provider.baseUrl)}`)
    console.log(`Keys: ${keys.length} (${[...counts].map(([health, count]) => `${health}=${count}`).join(', ')})`)
    console.table(rows)

    const duplicates = [...fingerprints.entries()].filter(([, ids]) => ids.length > 1)
    console.log('Duplicate plaintext credentials:', duplicates.length === 0 ? 'none' : '')
    for (const [fingerprint, ids] of duplicates) {
      console.log(`  sha256=${fingerprint}: ${ids.join(', ')}`)
    }

    console.log('Provider key audit timeline:')
    for (const event of audit.filter((item) => item.action.startsWith('key.'))) {
      const detail = detailOf(event.detail)
      const reason = typeof detail?.reason === 'string' ? `; reason=${detail.reason}` : ''
      const verdict = typeof detail?.verdict === 'string' ? `; verdict=${detail.verdict}` : ''
      console.log(
        `  ${iso(event.occurredAt)} ${event.action} ${event.outcome}` +
          ` key=${String(detail?.keyId ?? 'unknown')}${verdict}${reason}`,
      )
    }

    if (liveInference) {
      console.log(
        `Live inference verification (model=${inferenceModel}, max_tokens=1` +
          `${liveBaseUrl === undefined ? '' : `, baseUrl=${safeUrl(liveBaseUrl)}`}):`,
      )
      for (const key of keys.filter((candidate) => candidate.health === 'invalid_authentication')) {
        const baseUrl = liveBaseUrl ?? key.baseUrl ?? provider.baseUrl
        if (baseUrl === null) {
          console.log(`  ${key.id}: SKIPPED (no effective base URL)`)
          continue
        }

        let plaintext: string
        try {
          plaintext = await cipher.decrypt(key.encryptedKey)
        } catch {
          console.log(`  ${key.id}: SKIPPED (credential unreadable)`)
          continue
        }

        const endpoint = new URL(
          baseUrl.endsWith('/') ? `${baseUrl}chat/completions` : `${baseUrl}/chat/completions`,
        )
        let result: string
        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${plaintext}`,
              'content-type': 'application/json',
              accept: 'application/json',
            },
            body: JSON.stringify({
              model: inferenceModel,
              messages: [{ role: 'user', content: 'Reply with OK.' }],
              max_tokens: 1,
              stream: false,
            }),
            redirect: 'manual',
            signal: AbortSignal.timeout(15_000),
          })
          const body = await response.text()
          let upstreamCode = ''
          try {
            const parsed = JSON.parse(body) as { code?: unknown; error?: { code?: unknown } }
            const code = parsed.error?.code ?? parsed.code
            if (typeof code === 'string' || typeof code === 'number') upstreamCode = ` code=${code}`
          } catch {
            // Status is sufficient; do not print arbitrary upstream bodies.
          }
          const verdict = response.status >= 200 && response.status < 300
            ? 'VALID'
            : response.status === 401
              ? 'AUTH-REJECTED'
              : 'AUTH-ACCEPTED-REQUEST-REFUSED'
          result = `${verdict} HTTP ${response.status}${upstreamCode}`
        } catch (error) {
          const name = error instanceof Error ? error.name : 'Error'
          result = `INCONCLUSIVE ${name}`
        }
        console.log(`  ${key.id}: stored=${key.health}; ${result}`)
      }
    }
  }
} finally {
  await database.close()
}
