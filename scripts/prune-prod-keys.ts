/**
 * Prune PRODUCTION dashscope keys that the local pool has dropped as dead.
 *
 * The sync only ever adds; production health is driven by live request outcomes
 * and is not actively revalidated, so dead keys linger and keep getting routed.
 * This reveals each production dashscope key (the same admin endpoint the sync
 * uses), and deletes the ones whose plaintext is in the given death list.
 *
 * Usage:
 *   IROHA_ADMIN_KEY=... bun run scripts/prune-prod-keys.ts <dead.json> [--apply]
 *     dead.json: either ["sk-...", ...] or {"keys":[{"key":"sk-..."}, ...]}
 *   --all-not-in <live.json>   delete every dashscope key NOT in live.json
 *                              (default live file: ../dashscope/keys.json)
 */
import { readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const flagValue = (name: string): string | undefined => {
  const prefix = `--${name}=`
  const found = argv.find((a) => a.startsWith(prefix))
  return found === undefined ? undefined : found.slice(prefix.length)
}
const APPLY = argv.includes('--apply')
const positional = argv.filter((a) => !a.startsWith('--'))
const deadFile = positional[0]
const allNotInIdx = argv.indexOf('--all-not-in')
const allNotIn = allNotInIdx === -1 ? null : (argv[allNotInIdx + 1] ?? '../dashscope/keys.json')

if (deadFile === undefined && allNotIn === null) {
  console.error('Usage: prune-prod-keys.ts <dead.json> [--apply] | --all-not-in [live.json] [--apply]')
  process.exit(1)
}

const env = Object.fromEntries(
  readFileSync('C:/Users/ADMIN/Desktop/nguyenvu/iroha/.env', 'utf-8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)
const BASE = (env.IROHA_BASE_URL ?? 'https://iroha.nguyenvu.dev').replace(/\/+$/, '')
const ADMIN = env.IROHA_ADMIN_KEY ?? ''

interface KeyDto { readonly id: string; readonly health: string }

const request = async (path: string, method = 'GET') => {
  const r = await fetch(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${ADMIN}` } })
  const text = await r.text()
  let json: unknown = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: r.status, json }
}

const readKeys = (path: string): string[] => {
  const raw = JSON.parse(readFileSync(path, 'utf-8'))
  if (Array.isArray(raw)) return raw.map((e) => (typeof e === 'string' ? e : e.key)).filter(Boolean)
  return (raw.keys ?? []).map((e: { key?: string }) => e.key).filter(Boolean)
}

const live = allNotIn === null ? null : new Set(readKeys(allNotIn))
const dead = deadFile === undefined ? null : new Set(readKeys(deadFile))
console.log(`mode=${live ? `all-not-in ${allNotIn}` : `dead-list ${deadFile}`} apply=${APPLY}`)

const listing = await request('/api/v1/admin/providers')
if (listing.status !== 200) {
  console.error(`admin auth failed HTTP ${listing.status}`)
  process.exit(1)
}
const providers = (listing.json as { providers?: ReadonlyArray<{ id: string; handle: string; keys: ReadonlyArray<KeyDto> }> }).providers
  ?? (listing.json as ReadonlyArray<{ id: string; handle: string; keys: ReadonlyArray<KeyDto> }>)
const provider = providers.find((p) => p.handle === 'dashscope')
if (!provider) {
  console.error('dashscope provider not found')
  process.exit(1)
}

let deleted = 0
let kept = 0
for (const key of provider.keys) {
  const { status, json } = await request(`/api/v1/admin/providers/${provider.id}/keys/${key.id}/value`)
  const value = status === 200 && typeof json === 'object' && json !== null
    ? (json as { readonly value?: unknown }).value
    : undefined
  if (typeof value !== 'string') {
    console.log(`  ${key.id}: NOT REVEALED (health=${key.health})`)
    continue
  }
  const shouldDelete = live !== null ? !live.has(value) : dead!.has(value)
  if (!shouldDelete) {
    kept += 1
    continue
  }
  if (!APPLY) {
    console.log(`  [dry-run] would delete ${value.slice(0, 12)}… (health=${key.health})`)
    deleted += 1
    continue
  }
  const res = await request(`/api/v1/admin/providers/${provider.id}/keys/${key.id}`, 'DELETE')
  if (res.status === 200 || res.status === 204) {
    console.log(`  deleted ${value.slice(0, 12)}… (health=${key.health})`)
    deleted += 1
  } else {
    console.log(`  FAILED ${value.slice(0, 12)}… HTTP ${res.status} ${JSON.stringify(res.json).slice(0, 120)}`)
  }
}
console.log(`${APPLY ? 'deleted' : 'would delete'}=${deleted} kept=${kept} total=${provider.keys.length}`)