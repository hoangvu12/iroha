/**
 * TEMP dump (session 3 key hunt): reveal every PRODUCTION dashscope key through
 * the admin API (read-only — the same reveal the sync already performs) and
 * write key + health to ../dashscope/iroha_prod_keys.json, so keys that live
 * only in production can be re-verified locally.
 *
 * Delete after use.
 */
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('C:/Users/ADMIN/Desktop/nguyenvu/iroha/.env', 'utf-8')
    .split(/\r?\n/)
    .filter((line) => line.includes('=') && !line.startsWith('#'))
    .map((line) => {
      const i = line.indexOf('=')
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()]
    }),
)
const BASE = (env.IROHA_BASE_URL ?? 'https://iroha.nguyenvu.dev').replace(/\/+$/, '')
const ADMIN_KEY = env.IROHA_ADMIN_KEY ?? ''

interface KeyDto { readonly id: string; readonly health: string }

const request = async (path: string) => {
  const r = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${ADMIN_KEY}` } })
  const text = await r.text()
  let json: unknown = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: r.status, json }
}

const listing = await request('/api/v1/admin/providers')
if (listing.status !== 200) {
  console.error(`admin auth failed HTTP ${listing.status}: ${JSON.stringify(listing.json).slice(0, 200)}`)
  process.exit(1)
}
const providers = (listing.json as { providers?: ReadonlyArray<{ id: string; handle: string; baseUrl: string; keys: ReadonlyArray<KeyDto> }> }).providers
  ?? (listing.json as ReadonlyArray<{ id: string; handle: string; baseUrl: string; keys: ReadonlyArray<KeyDto> }>)

const rows: Record<string, unknown>[] = []
for (const provider of providers) {
  console.log(`provider ${provider.handle}: ${provider.keys.length} keys`)
  for (const key of provider.keys) {
    const { status, json } = await request(`/api/v1/admin/providers/${provider.id}/keys/${key.id}/value`)
    const value = status === 200 && typeof json === 'object' && json !== null
      ? (json as { readonly value?: unknown }).value
      : undefined
    rows.push({
      provider: provider.handle,
      keyId: key.id,
      health: key.health,
      key: typeof value === 'string' ? value : null,
      revealed: typeof value === 'string',
    })
  }
}
await Bun.write('C:/Users/ADMIN/Desktop/nguyenvu/dashscope/iroha_prod_keys.json',
  JSON.stringify({ source: 'iroha-prod-dump', keys: rows }, null, 1))
const revealed = rows.filter((r) => r.revealed).length
console.log(`dumped ${rows.length} keys (${revealed} revealed) -> dashscope/iroha_prod_keys.json`)