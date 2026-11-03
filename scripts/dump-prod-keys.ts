/**
 * Read-only dump of PRODUCTION upstream keys (reveals plaintext via the same admin
 * endpoint prune-prod-keys.ts uses). Writes {keys:[{key,health}]} to the given path.
 *
 * Never printed to stdout (only counts + short prefixes), so a shell transcript
 * cannot leak a live key.
 *
 * Usage: bun run scripts/dump-prod-keys.ts ../dashscope/prod_keys.json [providerHandle]
 */
import { readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const out = argv[0] ?? '../dashscope/prod_keys.json'
const handle = argv[1] ?? 'dashscope'

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

const request = async (path: string) => {
  const r = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${ADMIN}` } })
  const text = await r.text()
  let json: unknown = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: r.status, json }
}

const listing = await request('/api/v1/admin/providers')
if (listing.status !== 200) {
  console.error(`admin auth failed HTTP ${listing.status}`)
  process.exit(1)
}
const providers = (listing.json as { providers?: ReadonlyArray<{ id: string; handle: string; keys: ReadonlyArray<KeyDto> }> }).providers
  ?? (listing.json as ReadonlyArray<{ id: string; handle: string; keys: ReadonlyArray<KeyDto> }>)
const provider = providers.find((p) => p.handle === handle)
if (!provider) {
  console.error(`provider ${handle} not found`)
  process.exit(1)
}

const keys: Array<{ key: string; health: string }> = []
for (const key of provider.keys) {
  const { status, json } = await request(`/api/v1/admin/providers/${provider.id}/keys/${key.id}/value`)
  const value = status === 200 && typeof json === 'object' && json !== null
    ? (json as { readonly value?: unknown }).value
    : undefined
  if (typeof value === 'string') keys.push({ key: value, health: key.health })
  else console.log(`  ${key.id}: NOT REVEALED (health=${key.health})`)
}
writeFileSync(out, JSON.stringify({ source: `prod-${handle}`, keys }, null, 1))
console.log(`dumped ${keys.length}/${provider.keys.length} ${handle} production keys -> ${out}`)