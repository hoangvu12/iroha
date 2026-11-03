/**
 * Syncs the verified live-key pool into a PRODUCTION Iroha through the admin
 * HTTP API — the correct path when the deployment's database is not directly
 * reachable (unlike the dev Neon database the local scripts write to).
 *
 * Targets, in order: the dashscope pool from ../dashscope/keys.json, the z-ai
 * survivors from ../dashscope/vendor_z-ai_keys.json, and the zhipu survivors
 * from ../dashscope/vendor_zhipu_keys.json (creating the zhipu Provider when
 * it does not exist yet). Existing keys are revealed once each and deduplicated
 * by plaintext, so re-running the sync never duplicates a key. Per-key
 * `baseUrl` overrides are preserved for intl/US/QwenCloud/plan endpoints.
 *
 * Requires a Management Key with admin:read and admin:write scopes (created in
 * the production UI under Management Keys). A Gateway Key (gk_...) is NOT
 * sufficient — it authenticates inference and directory routes only.
 *
 * Usage:
 *   IROHA_ADMIN_KEY=<management-key> bun run scripts/sync-to-production.ts \
 *     [--base https://iroha.nguyenvu.dev] [--dry-run] [--key=<management-key>]
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const argv = process.argv.slice(2)
const flagValue = (name: string): string | undefined => {
  const prefix = `--${name}=`
  const found = argv.find((arg) => arg.startsWith(prefix))
  return found === undefined ? undefined : found.slice(prefix.length)
}
const DRY_RUN = argv.includes('--dry-run')
const BASE = (flagValue('base') ?? 'https://iroha.nguyenvu.dev').replace(/\/+$/, '')
const ADMIN_KEY = flagValue('key') ?? process.env.IROHA_ADMIN_KEY

if (ADMIN_KEY === undefined || ADMIN_KEY === '') {
  console.error('A Management Key is required: pass --key=<...> or set IROHA_ADMIN_KEY.')
  console.error('Create one in the production UI under Management Keys with admin:read + admin:write scopes.')
  process.exit(1)
}

interface KeyFileEntry {
  readonly url?: unknown
  readonly key?: unknown
}

interface ProviderDto {
  readonly id: string
  readonly handle: string
  readonly displayName: string
  readonly baseUrl: string
  readonly archived: boolean
  readonly keys: ReadonlyArray<{ readonly id: string; readonly health: string }>
}

const request = async (
  path: string,
  init: { readonly method?: string; readonly body?: unknown } = {}
): Promise<{ readonly status: number; readonly json: unknown }> => {
  const response = await fetch(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${ADMIN_KEY}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' })
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  })
  const text = await response.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  return { status: response.status, json }
}

const readKeyFile = (path: string): Array<{ readonly url: string; readonly key: string }> => {
  const raw = JSON.parse(readFileSync(resolve(path), 'utf-8')) as readonly KeyFileEntry[]
  const entries: Array<{ url: string; key: string }> = []
  const seen = new Set<string>()
  for (const item of raw) {
    const key = typeof item.key === 'string' ? item.key.trim() : ''
    const url = typeof item.url === 'string' ? item.url.trim().replace(/\/+$/, '') : ''
    if (key === '' || url === '' || seen.has(key)) continue
    seen.add(key)
    entries.push({ url, key })
  }
  return entries
}

const revealExisting = async (provider: ProviderDto): Promise<Set<string>> => {
  const values = new Set<string>()
  for (const key of provider.keys) {
    const { status, json } = await request(
      `/api/v1/admin/providers/${provider.id}/keys/${key.id}/value`
    )
    if (status === 200 && typeof json === 'object' && json !== null) {
      const value = (json as { readonly value?: unknown }).value
      if (typeof value === 'string') values.add(value)
    }
  }
  return values
}

const bulkAdd = async (
  provider: ProviderDto,
  entries: ReadonlyArray<{ readonly url: string; readonly key: string }>
): Promise<void> => {
  const providerBase = provider.baseUrl.replace(/\/+$/, '')
  const payload = entries.map((entry) => ({
    upstreamKey: entry.key,
    ...(entry.url === providerBase ? {} : { baseUrl: entry.url })
  }))
  for (let index = 0; index < payload.length; index += 200) {
    const chunk = payload.slice(index, index + 200)
    if (DRY_RUN) {
      console.log(`  [dry-run] would bulk-add ${chunk.length} key(s) to ${provider.handle}`)
      continue
    }
    const { status, json } = await request(
      `/api/v1/admin/providers/${provider.id}/keys/bulk`,
      { method: 'POST', body: { keys: chunk } }
    )
    const result = json as {
      readonly added?: ReadonlyArray<unknown>
      readonly failed?: ReadonlyArray<{ readonly index: number; readonly problems: ReadonlyArray<{ readonly message: string }> }>
    }
    const added = result?.added?.length ?? 0
    const failed = result?.failed ?? []
    console.log(`  ${provider.handle}: bulk add HTTP ${status} — ${added} added, ${failed.length} failed`)
    for (const entry of failed) {
      console.log(`    entry ${entry.index}: ${entry.problems.map((p) => p.message).join('; ')}`)
    }
  }
}

const run = async (): Promise<void> => {
  console.log(`Iroha production sync — ${BASE} — mode=${DRY_RUN ? 'DRY RUN' : 'APPLY'}`)
  const listing = await request('/api/v1/admin/providers')
  if (listing.status !== 200) {
    console.error(`admin authentication failed (HTTP ${listing.status}).`)
    console.error('A Management Key with admin:read + admin:write scopes is required (gk_ Gateway Keys are not accepted).')
    process.exit(1)
  }
  const providers = (listing.json as { readonly providers?: unknown }).providers as readonly ProviderDto[]
  console.log(`authenticated; ${providers.length} provider(s) visible`)
  const byHandle = new Map(providers.map((provider) => [provider.handle, provider]))

  const targets: ReadonlyArray<{ readonly handle: string; readonly file: string; readonly createUrl?: string }> = [
    { handle: 'dashscope', file: '../dashscope/keys.json' },
    { handle: 'z-ai', file: '../dashscope/vendor_z-ai_keys.json' },
    { handle: 'zhipu', file: '../dashscope/vendor_zhipu_keys.json', createUrl: 'https://open.bigmodel.cn/api/paas/v4' }
  ]

  for (const target of targets) {
    let entries: Array<{ url: string; key: string }>
    try {
      entries = readKeyFile(target.file)
    } catch {
      console.log(`\n${target.handle}: no file at ${target.file}, skipping`)
      continue
    }
    console.log(`\n${target.handle}: ${entries.length} verified key(s) in pool file`)

    let provider = byHandle.get(target.handle)
    if (provider === undefined && target.createUrl !== undefined && !DRY_RUN) {
      const created = await request('/api/v1/admin/providers', {
        method: 'POST',
        body: {
          handle: target.handle,
          displayName: target.handle === 'zhipu' ? 'Zhipu BigModel' : target.handle,
          baseUrl: target.createUrl,
          logoDomain: target.handle === 'zhipu' ? 'bigmodel.cn' : undefined,
          keys: entries.map((entry) => ({
            upstreamKey: entry.key,
            ...(entry.url === target.createUrl ? {} : { baseUrl: entry.url })
          }))
        }
      })
      if (created.status === 201) {
        provider = created.json as ProviderDto
        console.log(`  created provider ${provider.handle} (${provider.id}) with ${entries.length} key(s)`)
        continue
      }
      console.log(`  provider creation failed (HTTP ${created.status}): ${JSON.stringify(created.json).slice(0, 200)}`)
      continue
    }
    if (provider === undefined) {
      console.log(`  [dry-run] provider ${target.handle} does not exist; would create it with ${entries.length} key(s)`)
      continue
    }

    const existing = await revealExisting(provider)
    const missing = entries.filter((entry) => !existing.has(entry.key))
    console.log(`  ${provider.keys.length} existing key(s), ${existing.size} revealed, ${missing.length} to add`)
    if (missing.length === 0) continue
    for (const entry of missing) {
      const where = entry.url === provider.baseUrl.replace(/\/+$/, '') ? '(inherits provider base)' : entry.url
      console.log(`    + ${entry.key.slice(0, 7)}…${entry.key.slice(-4)}  ${where}`)
    }
    await bulkAdd(provider, missing)
  }

  console.log('\nsync complete.')
}

await run()
