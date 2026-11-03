/**
 * Revalidates every DashScope Upstream Key with a real minimal chat
 * completion — the only evidence that separates a live key from an arrears
 * one, since `GET /models` still answers 200 for accounts out of credit.
 *
 * A key that fails its stored endpoint is retried against the other DashScope
 * regions before being declared invalid; if another region accepts it, the
 * key's per-Key base URL is rewritten to the working endpoint (region repair)
 * instead of discarding a live credential.
 *
 * Health mapping mirrors the app's `probedPatch`/capacity reconciliation:
 * 200 -> active, 401 everywhere -> invalid_authentication, 402 -> exhausted
 * (retry in 24h), 429 -> cooling_down (retry in 60s), everything else
 * inconclusive -> cooling_down (retry in 30s). Disabled keys are left alone.
 *
 * Arrears exception (learned 2026-10-25): a key whose account is out of credit
 * authenticates but is refused with 400/403 "Access denied, please make sure your
 * account is in good standing" (CN) or "Access to model denied" (QwenCloud).  Those
 * bodies mention the word "model" in their help URL, so the model-unsupported
 * heuristic used to swallow them and the key was declared invalid_authentication —
 * exactly the keys that revive after a top-up.  They now map to `exhausted`.
 *
 * Usage:
 *   bun run scripts/revalidate-dashscope-keys.ts            # dry run
 *   bun run scripts/revalidate-dashscope-keys.ts --apply
 */
import { loadConfiguration } from '../src/config/environment.ts'
import { openDatabase } from '../src/persistence/index.ts'
import { createSecretCipher, SecretCipherError } from '../src/crypto/index.ts'

const APPLY = process.argv.includes('--apply')
const TIMEOUT_MS = 30_000
const CONCURRENCY = 12

const REGION_URLS = [
  'https://dashscope.aliyuncs.com/compatible-mode/v1',
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
]
const CODING_URLS = [
  'https://coding.dashscope.aliyuncs.com/v1',
  'https://coding-intl.dashscope.aliyuncs.com/v1',
]
const PLAN_PREFIX = /^(sk-sp-|sk-ws-|sk-tok-)/
const STANDARD_MODELS = ['qwen-plus', 'qwen-turbo', 'qwen3-coder-plus']
const PLAN_MODELS = ['qwen3-coder-plus', 'qwen3-coder-next', 'qwen-plus']

interface CompletionOutcome {
  readonly status: number
  readonly body: string
}

async function chatCompletion(
  baseUrl: string,
  key: string,
  model: string,
): Promise<CompletionOutcome> {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    return { status: response.status, body: (await response.text()).slice(0, 400) }
  } catch (error) {
    const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : ''
    return { status: 0, body: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network error' }
  }
}

interface Verdict {
  readonly verdict: 'authenticated' | 'rejected' | 'inconclusive' | 'exhausted'
  readonly reason: string
  readonly workingUrl: string | null
}

function candidateUrls(plaintext: string, storedUrl: string): string[] {
  const primary = PLAN_PREFIX.test(plaintext)
    ? [storedUrl, ...CODING_URLS, ...REGION_URLS]
    : [storedUrl, ...REGION_URLS]
  return [...new Set(primary.map((u) => u.replace(/\/+$/, '')))]
}

function candidateModels(plaintext: string): string[] {
  return PLAN_PREFIX.test(plaintext) ? PLAN_MODELS : STANDARD_MODELS
}

function modelUnsupported(status: number, body: string): boolean {
  return (status === 404 || status === 400) && /model|not supported/i.test(body)
}

/**
 * True when the upstream recognised the credential but refused service because the
 * account is out of credit / in arrears (never evidence of a dead key).
 */
function arrearsRefusal(status: number, body: string): boolean {
  if (status !== 400 && status !== 403) return false
  return /good standing|arrear|overdue|free quota|quota has been|insufficient|add funds|balance/i.test(body)
}

async function probeKey(storedUrl: string, key: string): Promise<Verdict> {
  const ordered = candidateUrls(key, storedUrl)
  for (const model of candidateModels(key)) {
    let last: CompletionOutcome = { status: 0, body: '' }
    for (const url of ordered) {
      last = await chatCompletion(url, key, model)
      if (last.status === 200) {
        return {
          verdict: 'authenticated',
          reason: `live chat completion returned HTTP 200 via ${new URL(url).host} (${model})`,
          workingUrl: url,
        }
      }
      if (last.status === 401) continue
      if (arrearsRefusal(last.status, last.body)) {
        return {
          verdict: 'exhausted',
          reason: 'upstream recognised the key but the account is in arrears / out of quota',
          workingUrl: null,
        }
      }
      if (modelUnsupported(last.status, last.body)) break
      if (last.status === 402) {
        return { verdict: 'exhausted', reason: 'upstream reports payment required (HTTP 402)', workingUrl: null }
      }
      if (last.status === 429) {
        return { verdict: 'inconclusive', reason: 'upstream rate-limited the test (HTTP 429)', workingUrl: null }
      }
      if (last.status === 0) continue
      break
    }
    if (last.status === 401) continue
    if (arrearsRefusal(last.status, last.body)) {
      return {
        verdict: 'exhausted',
        reason: 'upstream recognised the key but the account is in arrears / out of quota',
        workingUrl: null,
      }
    }
    if (modelUnsupported(last.status, last.body)) continue
    if (last.status !== 0) {
      return { verdict: 'inconclusive', reason: `upstream answered HTTP ${last.status} on every region`, workingUrl: null }
    }
  }
  return {
    verdict: 'rejected',
    reason: 'every DashScope endpoint rejected the key (HTTP 401)',
    workingUrl: null,
  }
}

interface KeyRow {
  readonly id: string
  readonly health: string
  readonly baseUrl: string | null
  readonly encryptedKey: string
}

const config = loadConfiguration()
const db = openDatabase(config.database)
const cipher = createSecretCipher(config.masterKey)

try {
  const provider = await db.providers.getProviderByHandle('dashscope')
  if (provider === null) throw new Error('Provider "dashscope" not found')

  const rows = (await db.providers.listKeys(provider.id)) as readonly KeyRow[]
  const providerDefault = provider.baseUrl
  console.log(`DashScope (${provider.id}): ${rows.length} keys; mode=${APPLY ? 'APPLY' : 'DRY RUN'}\n`)

  interface Result {
    readonly id: string
    readonly key: string
    readonly previousHealth: string
    readonly newHealth: string
    readonly verdict: string
    readonly reason: string
    readonly baseUrlRewrite: string | null
  }

  const queue = [...rows]
  const results: Result[] = []

  async function worker(): Promise<void> {
    for (;;) {
      const row = queue.shift()
      if (row === undefined) return
      const storedUrl = (row.baseUrl ?? providerDefault).replace(/\/+$/, '')

      let plaintext: string
      try {
        plaintext = await cipher.decrypt(row.encryptedKey)
      } catch (cause) {
        if (cause instanceof SecretCipherError) {
          results.push({
            id: row.id, key: 'unreadable', previousHealth: row.health, newHealth: row.health,
            verdict: 'skipped', reason: 'stored key unreadable with this master key', baseUrlRewrite: null,
          })
          continue
        }
        throw cause
      }

      const { verdict, reason, workingUrl } = await probeKey(storedUrl, plaintext)
      const at = new Date()
      let newHealth: string = row.health
      if (row.health !== 'disabled') {
        if (verdict === 'authenticated') newHealth = 'active'
        else if (verdict === 'rejected') newHealth = 'invalid_authentication'
        else if (verdict === 'exhausted') newHealth = 'exhausted'
        else newHealth = 'cooling_down'
      }
      const rewrite =
        verdict === 'authenticated' && workingUrl !== null && workingUrl !== storedUrl
          ? (workingUrl === providerDefault.replace(/\/+$/, '') ? null : workingUrl)
          : null
      results.push({
        id: row.id, key: plaintext, previousHealth: row.health, newHealth, verdict, reason,
        baseUrlRewrite: rewrite,
      })

      if (APPLY) {
        const patch: Record<string, unknown> = {
          lastProbeAt: at,
          lastProbeVerdict: verdict,
          lastProbeReason: reason.slice(0, 300),
          healthReason: reason.slice(0, 300),
        }
        if (row.health !== 'disabled') {
          patch.health = newHealth
          patch.healthChangedAt = at
          patch.healthScope = 'key'
          patch.healthScopeId = row.id
          patch.healthModel = null
          patch.retryAfterAt =
            newHealth === 'cooling_down' ? new Date(at.getTime() + 60_000)
            : newHealth === 'exhausted' ? new Date(at.getTime() + 24 * 60 * 60_000)
            : null
        }
        if (rewrite !== null) patch.baseUrl = rewrite
        if (verdict === 'authenticated' && rewrite === null && row.baseUrl !== null
            && workingUrl === providerDefault.replace(/\/+$/, '')) {
          patch.baseUrl = null
        }
        await db.transaction(async (repositories) => {
          await repositories.providers.updateKey(row.id, patch as never, at)
          await repositories.audit.record({
            action: 'key.tested',
            outcome: verdict === 'authenticated' ? 'success' : 'failure',
            detail: { providerId: provider.id, keyId: row.id, verdict, reason: reason.slice(0, 200) },
            at,
          })
        })
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))

  const counts: Record<string, number> = {}
  for (const r of results) counts[r.newHealth] = (counts[r.newHealth] ?? 0) + 1
  console.log('RESULTS:')
  for (const r of results) {
    const masked = `${r.key.slice(0, 7)}…${r.key.slice(-4)}`
    const change = r.previousHealth === r.newHealth ? '' : `  ${r.previousHealth} -> ${r.newHealth}`
    const rewrite = r.baseUrlRewrite === null ? '' : `  baseUrl=${r.baseUrlRewrite}`
    const reason = r.verdict === 'authenticated' ? '' : `  [${r.reason}]`
    console.log(`  ${masked}  ${r.verdict}${change}${rewrite}${reason}`)
  }
  console.log(`\n${results.length} key(s) revalidated. Final health: ${JSON.stringify(counts)}`)
  if (!APPLY) console.log('Dry run. Pass --apply to write the changes.')
} finally {
  await db.close()
}
