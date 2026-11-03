/**
 * Reads every unique z.ai key from nyanis, probes the Zhipu entitlement API
 * (`/api/monitor/usage/quota/limit`) for each key, and imports every key that
 * has a visible entitlement response — subscription plan (code 200 with limits)
 * or credit-based pay-go (code 500). Keys whose entitlement host cannot
 * authenticate are skipped.
 *
 * Usage:
 *   bun run scripts/import-zai-keys.ts [--apply]
 */
import { Database } from 'bun:sqlite'
import { loadConfiguration } from '../src/config/environment.ts'
import { openDatabase } from '../src/persistence/index.ts'
import { createSecretCipher } from '../src/crypto/index.ts'
import { zaiUsageReadings } from '../src/usage/zai-usage-adapter.ts'
import crypto from 'node:crypto'
import { resolve } from 'node:path'

const APPLY = process.argv.includes('--apply')
const NYANIS_DB = resolve(process.cwd(), '../nyanis/nyanis.sqlite')
const ZAI_PROVIDER_HANDLE = 'z-ai'
const PROBE_TIMEOUT_MS = 10_000

const ZAI_KEY_RE = /^[0-9a-fA-F]{32}\.[A-Za-z0-9_-]{16,}$/

function isSkippable(key: string): boolean {
  return !ZAI_KEY_RE.test(key)
}

function entitlementHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase().endsWith('bigmodel.cn')
      ? 'https://open.bigmodel.cn'
      : 'https://api.z.ai'
  } catch {
    return 'https://api.z.ai'
  }
}

interface EntitlementResult {
  key: string
  url: string
  entitlementHost: string
  ok: boolean
  code: number
  status: number
  body: unknown
}

async function checkEntitlement(key: string, baseUrl: string): Promise<EntitlementResult> {
  const host = entitlementHost(baseUrl)
  const quotaUrl = `${host}/api/monitor/usage/quota/limit`

  try {
    const response = await fetch(quotaUrl, {
      method: 'GET',
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })

    const { status } = response
    let body: unknown
    try {
      body = await response.json()
    } catch {
      body = null
    }

    if (status === 401 || status === 403) {
      return { key, url: baseUrl, entitlementHost: host, ok: false, code: 0, status, body }
    }

    const parsed = body as Record<string, unknown> | null
    if (!parsed || typeof parsed !== 'object') {
      return { key, url: baseUrl, entitlementHost: host, ok: false, code: 0, status, body }
    }

    const successfulResponse = parsed.success === true || parsed.code === 200

    if (successfulResponse) {
      const readings = zaiUsageReadings(body)
      if (readings.length > 0) {
        return { key, url: baseUrl, entitlementHost: host, ok: true, code: 200, status: 200, body }
      }

      if (parsed.success === false && parsed.code === 500) {
        return { key, url: baseUrl, entitlementHost: host, ok: true, code: 500, status, body }
      }
    }

    const authCode = parsed.code
    if (authCode === 1000 || authCode === 1001) {
      return { key, url: baseUrl, entitlementHost: host, ok: false, code: Number(authCode), status, body }
    }

    return { key, url: baseUrl, entitlementHost: host, ok: true, code: Number(authCode) || 200, status, body }
  } catch (error) {
    const isTimeout =
      typeof error === 'object' && error !== null &&
      ((error as { name?: unknown }).name === 'TimeoutError' || (error as { name?: unknown }).name === 'AbortError')
    return {
      key, url: baseUrl, entitlementHost: host,
      ok: false, code: 0, status: 0, body: isTimeout ? 'timeout' : 'network error',
    }
  }
}

function describeBody(body: unknown): string {
  if (typeof body !== 'object' || body === null) return String(body)
  const r = body as Record<string, unknown>
  const code = r.code
  const success = r.success
  const level = (r.data as Record<string, unknown> | undefined)?.level
  const parts: string[] = []
  if (code !== undefined) parts.push(`code=${code}`)
  if (success !== undefined) parts.push(`success=${success}`)
  if (level !== undefined) parts.push(`level=${level}`)
  return parts.join(' ') || 'ok'
}

async function main(): Promise<void> {
  console.log('Reading nyanis database...')
  const nyanis = new Database(NYANIS_DB)

  const rows = nyanis
    .query(
      `SELECT DISTINCT c.key, c.url
       FROM candidates c
       WHERE (c.url LIKE '%z.ai%' OR c.url LIKE '%bigmodel.cn%' OR c.url LIKE '%zcode.z.ai%' OR c.url LIKE '%open.z.ai%')
         AND c.vendor = 'zhipu'
         AND length(c.key) > 10
       ORDER BY c.key, c.url`,
    )
    .all() as { key: string; url: string }[]

  nyanis.close()

  const rawEntries: { key: string; url: string }[] = rows.filter((r) => {
    return !isSkippable(r.key.trim())
  })

  console.log(`Found ${rawEntries.length} (key, url) pairs in nyanis.`)

  const grouped = new Map<string, Set<string>>()
  for (const { key, url } of rawEntries) {
    const k = key.trim()
    if (!grouped.has(k)) grouped.set(k, new Set())
    grouped.get(k)!.add(url.trim())
  }
  console.log(`  ${grouped.size} unique keys across ${rawEntries.length} pairs.`)

  console.log(`\nProbing each key against the Z.ai entitlement API ...`)
  const valid: EntitlementResult[] = []
  const invalid: EntitlementResult[] = []

  let done = 0
  for (const [key, urls] of grouped) {
    const results = await Promise.all(
      [...urls].map((url) => checkEntitlement(key, url)),
    )

    const good = results.find((r) => r.ok)

    if (good) {
      valid.push(good)
      const readings = zaiUsageReadings(good.body)
      if (readings.length > 0) {
        const r = readings[0]
        console.log(`  [SUB] ${key.slice(0, 20)}...${key.slice(-6)}  plan=${r.plan} remaining=${r.remainingPercent}% reset=${r.resetAt?.toISOString().slice(0, 10) ?? '?'}  @ ${good.url}`)
      } else {
        console.log(`  [PAY] ${key.slice(0, 20)}...${key.slice(-6)}  pay-as-you-go (no subscription)  @ ${good.url}`)
      }
    } else {
      const first = results[0]
      invalid.push(first)
    }

    done += 1
    if (done % 100 === 0) console.log(`  Progress: ${done}/${grouped.size}`)
  }

  console.log(`\n=== RESULTS ===`)
  console.log(`  Valid entitlement:  ${valid.length}`)
  console.log(`  Invalid/no auth:    ${invalid.length}`)

  const subscriptionKeys = valid.filter((r) => {
    const readings = zaiUsageReadings(r.body)
    return readings.length > 0
  })
  const paygoKeys = valid.filter((r) => {
    const readings = zaiUsageReadings(r.body)
    return readings.length === 0
  })
  console.log(`  Subscription:       ${subscriptionKeys.length}`)
  console.log(`  Pay-as-you-go:      ${paygoKeys.length}`)

  const toImport = subscriptionKeys
  console.log(`\nSkipping ${paygoKeys.length} pay-as-you-go key(s) (no subscription, credit cannot be confirmed via entitlement API).`)

  if (toImport.length === 0) {
    console.log('No keys to import.')
    return
  }

  if (!APPLY) {
    console.log(`\nDry run. Would import ${valid.length} key(s) to Iroha.`)
    for (const r of toImport) {
      const readings = zaiUsageReadings(r.body)
      if (readings.length > 0) {
        const u = readings[0]
        console.log(`  [SUB] ${r.key.slice(0, 24)}...${r.key.slice(-6)}  remaining=${u.remainingPercent}% reset=${u.resetAt?.toISOString().slice(0, 10) ?? '?'}  baseUrl=${r.url}`)
      } else {
        console.log(`  [PAY] ${r.key.slice(0, 24)}...${r.key.slice(-6)}  pay-as-you-go  baseUrl=${r.url}`)
      }
    }
    console.log('\nPass --apply to write to Iroha.')
    return
  }

  console.log(`\nImporting ${toImport.length} subscription key(s) to Iroha...`)

  const config = loadConfiguration()
  const db = openDatabase(config.database)
  const cipher = createSecretCipher(config.masterKey)

  try {
    const provider = await db.providers.getProviderByHandle(ZAI_PROVIDER_HANDLE)
    if (provider === null) {
      console.error(`Provider "${ZAI_PROVIDER_HANDLE}" not found in Iroha.`)
      process.exit(1)
    }
    const providerId = provider.id
    console.log(`Provider: ${provider.displayName} (${providerId}), default baseUrl: ${provider.baseUrl}`)

    const existingKeys = await db.providers.listKeys(providerId)
    const existingPlaintexts = new Set<string>()
    for (const ek of existingKeys) {
      try {
        const pt = await cipher.decrypt(ek.encryptedKey)
        existingPlaintexts.add(pt)
      } catch {}
    }
    console.log(`  ${existingKeys.length} existing key(s) on this provider`)

    let added = 0
    let skipped = 0
    for (const entry of toImport) {
      if (existingPlaintexts.has(entry.key)) {
        skipped += 1
        continue
      }

      const at = new Date()
      const keyId = `uk_${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url')}`
      const baseUrlOverride = entry.url !== provider.baseUrl ? entry.url : null

      const readings = zaiUsageReadings(entry.body)
      const hasSubscription = readings.length > 0

      const health = hasSubscription ? 'active' : 'active'

      await db.transaction(async (repositories) => {
        await repositories.providers.insertKey({
          id: keyId,
          providerId,
          baseUrl: baseUrlOverride,
          accountId: null,
          encryptedKey: await cipher.encrypt(entry.key),
          health,
          lastProbeAt: at,
          lastProbeVerdict: 'authenticated',
          lastProbeReason: hasSubscription
            ? `entitlement: remaining=${readings[0].remainingPercent}%`
            : 'entitlement: pay-as-you-go (code 500)',
          healthReason: hasSubscription
            ? `subscription, remaining ${readings[0].remainingPercent}%`
            : 'pay-as-you-go credit',
          healthChangedAt: at,
          retryAfterAt: null,
          healthScope: 'key',
          healthScopeId: null,
          healthModel: null,
          allowedModels: null,
          deniedModels: null,
          createdAt: at,
          updatedAt: at,
        })
        await repositories.audit.record({
          action: 'key.created',
          outcome: 'success',
          detail: {
            providerId,
            keyId,
            source: 'import-zai-keys',
            entitlement: hasSubscription ? 'subscription' : 'pay-as-you-go',
            ...(hasSubscription ? {
              remainingPercent: readings[0].remainingPercent,
              resetAt: readings[0].resetAt?.toISOString(),
            } : {}),
            baseUrl: baseUrlOverride ?? '(inherited)',
          },
          at,
        })
      })

      added += 1
      if (added % 100 === 0) console.log(`  Imported ${added}/${valid.length} ...`)
    }

    console.log(`  Added: ${added}, Skipped (duplicate): ${skipped}`)

    const finalKeys = await db.providers.listKeys(providerId)
    console.log(`  Total keys on provider now: ${finalKeys.length}`)
    const healthCounts = new Map<string, number>()
    for (const k of finalKeys) {
      healthCounts.set(k.health, (healthCounts.get(k.health) ?? 0) + 1)
    }
    for (const [h, c] of healthCounts) console.log(`    ${h}: ${c}`)
  } finally {
    await db.close()
  }
}

await main()