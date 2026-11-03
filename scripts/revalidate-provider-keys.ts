/**
 * Revalidates every Upstream Key on the live (non-archived) Providers with a
 * real minimal chat completion — stronger evidence than the models-endpoint
 * probe, which many providers do not expose and which answers 200 even for
 * out-of-credit accounts.
 *
 * The request shape follows each key's effective base URL: URLs containing
 * "anthropic" get an Anthropic-style `/v1/messages` call, everything else an
 * OpenAI-style `/chat/completions` call. Up to three cheap chat models are
 * tried per provider, so a single retired model id does not misreport a live
 * key. Health mapping mirrors the app's probe/capacity semantics: 200 ->
 * active, 401 -> invalid_authentication, 402 -> exhausted (24h), 429 ->
 * cooling_down (60s), everything else inconclusive -> cooling_down (30s).
 * Disabled keys are left alone.
 *
 * Usage:
 *   bun run scripts/revalidate-provider-keys.ts [--provider <handle> ...]   # dry run
 *   bun run scripts/revalidate-provider-keys.ts --all --apply
 */
import { loadConfiguration } from '../src/config/environment.ts'
import { openDatabase } from '../src/persistence/index.ts'
import { createSecretCipher, SecretCipherError } from '../src/crypto/index.ts'

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const ALL = argv.includes('--all')
const providersFlagged: string[] = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--provider' && argv[i + 1] !== undefined) providersFlagged.push(argv[i + 1])
}
if (!ALL && providersFlagged.length === 0) {
  console.error('Usage: bun run scripts/revalidate-provider-keys.ts --all | --provider <handle> [...] [--apply]')
  process.exit(1)
}

const TIMEOUT_MS = 30_000
const CONCURRENCY = 12

const PROVIDER_MODELS: Record<string, readonly string[]> = {
  agnes: ['agnes-2.5-flash', 'agnes-2.0-flash'],
  cerebras: ['qwen-3.8-27b', 'gpt-oss-120b'],
  cohere: ['command-a-03-2025', 'command-r-plus-08-2024', 'tiny-aya-global'],
  groq: ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile'],
  manus: ['gpt-5-nano', 'gpt-5-mini', 'gpt-5'],
  minimax: ['MiniMax-M2.5', 'MiniMax-M2.1', 'MiniMax-M2.1-highspeed'],
  mistral: ['ministral-14b-2512', 'mistral-medium-3.5', 'mistral-small-latest'],
  modelscope: ['Qwen/Qwen3.5-35B-A3B', 'MiniMax/MiniMax-M1-80k', 'Qwen/Qwen3-Coder-30B-A3B-Instruct'],
  nousresearch: ['openai/gpt-5-nano', 'qwen/qwen3-next-80b-a3b-instruct', 'openai/gpt-3.5-turbo-16k'],
  'tencent-lkeap': ['deepseek-v3', 'deepseek-v3.1', 'deepseek-v3-0324'],
  'z-ai': ['glm-5.3-flash', 'glm-5.2', 'glm-4.5'],
}

interface CompletionOutcome {
  readonly status: number
  readonly body: string
}

function anthropicMessagesUrl(baseUrl: string): string {
  let b = baseUrl.replace(/\/+$/, '')
  if (b.endsWith('/messages')) return b
  b = b.replace(/\/v1$/, '')
  return `${b}/v1/messages`
}

async function completion(
  baseUrl: string,
  key: string,
  model: string,
): Promise<CompletionOutcome> {
  const isAnthropic = baseUrl.includes('anthropic')
  const url = isAnthropic
    ? anthropicMessagesUrl(baseUrl)
    : `${baseUrl.replace(/\/+$/, '')}/chat/completions`
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (isAnthropic) {
    headers['x-api-key'] = key
    headers.authorization = `Bearer ${key}`
    headers['anthropic-version'] = '2023-06-01'
  } else {
    headers.authorization = `Bearer ${key}`
  }
  const body = JSON.stringify({
    model,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
  })
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    return { status: response.status, body: (await response.text()).slice(0, 400) }
  } catch (error) {
    const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : ''
    return { status: 0, body: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network error' }
  }
}

function modelUnsupported(outcome: CompletionOutcome): boolean {
  return (outcome.status === 404 || outcome.status === 400)
    && /model|not supported|not found|不存在|unsupported/i.test(outcome.body)
}

type VerdictKind = 'authenticated' | 'rejected' | 'inconclusive' | 'exhausted'

interface Verdict {
  readonly kind: VerdictKind
  readonly reason: string
}

async function probeKey(
  baseUrl: string,
  key: string,
  models: readonly string[],
): Promise<Verdict> {
  let last: CompletionOutcome = { status: 0, body: '' }
  for (const model of models) {
    last = await completion(baseUrl, key, model)
    if (last.status === 200) {
      return { kind: 'authenticated', reason: `live chat completion returned HTTP 200 (${model})` }
    }
    if (modelUnsupported(last)) continue
    break
  }
  if (last.status === 401) return { kind: 'rejected', reason: 'upstream rejected the key (HTTP 401)' }
  if (last.status === 402) return { kind: 'exhausted', reason: 'upstream reports payment required (HTTP 402)' }
  if (last.status === 429) return { kind: 'inconclusive', reason: 'upstream rate-limited the test (HTTP 429)' }
  if (last.status === 0) return { kind: 'inconclusive', reason: `upstream unreachable (${last.body})` }
  return { kind: 'inconclusive', reason: `upstream answered HTTP ${last.status}` }
}

const config = loadConfiguration()
const db = openDatabase(config.database)
const cipher = createSecretCipher(config.masterKey)

interface KeyRow {
  readonly id: string
  readonly health: string
  readonly baseUrl: string | null
  readonly encryptedKey: string
}

try {
  const allProviders = await db.providers.listProviders()
  const selected = ALL
    ? allProviders.filter((p) => p.archivedAt === null && p.handle !== 'dashscope')
    : allProviders.filter((p) => providersFlagged.includes(p.handle))

  if (selected.length === 0) {
    console.log('No matching providers.')
    process.exit(0)
  }
  console.log(`mode=${APPLY ? 'APPLY' : 'DRY RUN'}; providers: ${selected.map((p) => p.handle).join(', ')}\n`)

  interface Result {
    readonly provider: string
    readonly key: string
    readonly previousHealth: string
    readonly newHealth: string
    readonly verdict: string
    readonly reason: string
  }

  const results: Result[] = []
  const queue: { provider: (typeof selected)[number]; row: KeyRow }[] = []
  for (const provider of selected) {
    const rows = (await db.providers.listKeys(provider.id)) as readonly KeyRow[]
    for (const row of rows) queue.push({ provider, row })
  }
  console.log(`${queue.length} key(s) to revalidate.\n`)

  async function worker(): Promise<void> {
    for (;;) {
      const item = queue.shift()
      if (item === undefined) return
      const { provider, row } = item
      const models = PROVIDER_MODELS[provider.handle] ?? []
      const baseUrl = (row.baseUrl ?? provider.baseUrl) ?? ''
      if (baseUrl === '' || models.length === 0) {
        results.push({
          provider: provider.handle, key: '?', previousHealth: row.health, newHealth: row.health,
          verdict: 'skipped', reason: baseUrl === '' ? 'no base URL' : 'no probe model known',
        })
        continue
      }

      let plaintext: string
      try {
        plaintext = await cipher.decrypt(row.encryptedKey)
      } catch (cause) {
        if (cause instanceof SecretCipherError) {
          results.push({
            provider: provider.handle, key: 'unreadable', previousHealth: row.health,
            newHealth: row.health, verdict: 'skipped', reason: 'stored key unreadable',
          })
          continue
        }
        throw cause
      }

      const { kind, reason } = await probeKey(baseUrl, plaintext, models)
      const at = new Date()
      let newHealth: string = row.health
      if (row.health !== 'disabled') {
        if (kind === 'authenticated') newHealth = 'active'
        else if (kind === 'rejected') newHealth = 'invalid_authentication'
        else if (kind === 'exhausted') newHealth = 'exhausted'
        else newHealth = 'cooling_down'
      }
      results.push({ provider: provider.handle, key: plaintext, previousHealth: row.health, newHealth, verdict: kind, reason })

      if (APPLY) {
        const patch: Record<string, unknown> = {
          lastProbeAt: at,
          lastProbeVerdict: kind,
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
        await db.transaction(async (repositories) => {
          await repositories.providers.updateKey(row.id, patch as never, at)
          await repositories.audit.record({
            action: 'key.tested',
            outcome: kind === 'authenticated' ? 'success' : 'failure',
            detail: { providerId: provider.id, keyId: row.id, verdict: kind, reason: reason.slice(0, 200) },
            at,
          })
        })
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))

  const byProvider: Record<string, Record<string, number>> = {}
  for (const r of results) {
    byProvider[r.provider] ??= {}
    byProvider[r.provider][r.newHealth] = (byProvider[r.provider][r.newHealth] ?? 0) + 1
  }
  console.log('CHANGES:')
  for (const r of results) {
    if (r.verdict === 'skipped' || r.previousHealth === r.newHealth) continue
    const masked = r.key.length > 12 ? `${r.key.slice(0, 7)}…${r.key.slice(-4)}` : r.key
    console.log(`  ${r.provider.padEnd(15)} ${masked.padEnd(14)} ${r.previousHealth} -> ${r.newHealth}  [${r.reason}]`)
  }
  console.log('\nFINAL HEALTH BY PROVIDER:')
  for (const [handle, counts] of Object.entries(byProvider)) console.log(`  ${handle.padEnd(15)} ${JSON.stringify(counts)}`)
  if (!APPLY) console.log('\nDry run. Pass --apply to write the changes.')
} finally {
  await db.close()
}
