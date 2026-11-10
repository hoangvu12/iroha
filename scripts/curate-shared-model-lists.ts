/**
 * Rewrites the shared family Providers from a curated model plan.
 *
 * The plan (produced by relay-hunt's `tools/model_plan.py`) says, per family
 * Provider, which catalogue models that Provider offers and which exact wire
 * spelling each Upstream Key uses for each of them. A model sits on exactly one
 * Provider; one endpoint may sit on several.
 *
 * Two shapes are supported:
 *
 *   --mode in-place   Patch the existing Keys' model lists and the catalog.
 *                     Keeps every Provider id, so scoped Gateway Keys survive.
 *                     Cannot remove the `discovered` catalog rows or the stale
 *                     Key Model Availability rows the API has no route for, so
 *                     the Provider keeps advertising what it never serves.
 *
 *   --mode rebuild    Archive and purge the Provider, then recreate it with the
 *                     same handle and the curated keys. The purge cascades the
 *                     stale Key Model Availability and the discovered catalog
 *                     away, which is the only way the admin API can clear them.
 *                     The Provider id changes, so scoped Gateway Keys that
 *                     named it are replaced (new secret) by this script.
 *
 * Dry run unless --apply is given. Never prints a secret.
 *
 * Usage:
 *   bun run scripts/curate-shared-model-lists.ts ../relay-hunt/pool/model-plan.json
 *   bun run scripts/curate-shared-model-lists.ts ../relay-hunt/pool/model-plan.json --apply --mode rebuild --verify
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const argv = process.argv.slice(2)
const positional = argv.filter((a) => !a.startsWith('--'))
const PLAN_PATH = positional[0]
const APPLY = argv.includes('--apply')
const VERIFY = argv.includes('--verify')
const MODE = (argv.includes('--mode') ? argv[argv.indexOf('--mode') + 1] : 'in-place') as
  | 'in-place'
  | 'rebuild'

if (!PLAN_PATH) {
  console.error('usage: curate-shared-model-lists.ts <plan.json> [--apply] [--mode in-place|rebuild] [--verify]')
  process.exit(1)
}

const env = Object.fromEntries(
  readFileSync(resolve(process.cwd(), '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)
const BASE = (env.IROHA_BASE_URL ?? 'https://iroha.nguyenvu.dev').replace(/\/+$/, '')
const ADMIN = env.IROHA_ADMIN_KEY ?? ''

interface PlanKey {
  readonly keyId: string | null
  readonly baseUrl: string
  readonly allowedModels: readonly string[]
  readonly modelRewrites: Record<string, string>
}
interface PlanProvider {
  readonly handle: string
  readonly models: readonly string[]
  readonly keys: readonly PlanKey[]
}
interface Plan {
  readonly providers: Record<string, PlanProvider>
  readonly duplicateModels?: Record<string, string[]>
}

const plan: Plan = JSON.parse(readFileSync(PLAN_PATH, 'utf8'))

interface ProviderDto {
  readonly id: string
  readonly handle: string
  readonly displayName: string
  readonly baseUrl: string
  readonly archived: boolean
  readonly enabled: boolean
  readonly allowInsecureHttp: boolean
  readonly requiresUpstreamKey: boolean
  readonly modelDiscovery: string | null
  readonly retryAmbiguousNetwork?: boolean
  readonly keys: ReadonlyArray<{
    readonly id: string
    readonly baseUrl: string | null
    readonly allowedModels: readonly string[] | null
    readonly modelRewrites: Record<string, string> | null
    readonly health: string
  }>
}
interface CatalogEntry {
  readonly modelId: string
  readonly source: 'discovered' | 'template' | 'owner_added' | 'excluded'
  readonly excluded: boolean
  readonly overrides: {
    readonly chat?: boolean
    readonly streaming?: boolean
    readonly tools?: boolean
    readonly structuredOutput?: boolean
    readonly responses?: boolean
  } | null
}
interface GatewayKeyDto {
  readonly id: string
  readonly name: string
  readonly access: { readonly mode: string; readonly providers?: ReadonlyArray<{ readonly providerId: string; readonly models: readonly string[] | null }> }
  readonly scope?: ReadonlyArray<{ readonly providerId: string; readonly models: readonly string[] | null }>
}

const request = async (
  method: string,
  path: string,
  body?: unknown,
): Promise<{ readonly status: number; readonly json: any }> => {
  const response = await fetch(`${BASE}/api/v1/admin${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      accept: 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let json: unknown = null
  try {
    json = text.length > 0 ? JSON.parse(text) : null
  } catch {
    json = text
  }
  return { status: response.status, json }
}

const admin = async (method: string, path: string, body?: unknown) => {
  const { status, json } = await request(method, path, body)
  if (status >= 400) {
    throw new Error(`${method} ${path} -> ${status} ${JSON.stringify(json).slice(0, 300)}`)
  }
  return json
}

  const listing = (): Promise<ProviderDto[]> =>
  admin('GET', '/providers').then((r) => r.providers ?? r.data ?? [])

const snapshot = async (providers: ProviderDto[]): Promise<void> => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = PLAN_PATH.includes('/') ? PLAN_PATH.slice(0, PLAN_PATH.lastIndexOf('/')) : '.'
  const path = `${dir}/model-plan-backup-${stamp}.json`
  const out: unknown[] = []
  for (const provider of providers) {
    const catalog = await catalogOf(provider.id)
    out.push({ provider, catalog })
  }
  writeFileSync(path, JSON.stringify(out, null, 1))
  console.log(`\nsnapshot written to ${path}`)
}

const catalogOf = async (providerId: string): Promise<CatalogEntry[]> => {
  const view = await admin('GET', `/providers/${providerId}/catalog`)
  return view.entries ?? []
}

/**
 * Establishes chat support for the curated models that do not carry it yet.
 *
 * ADR-0025: the Models surfaces report chat support only when the Provider,
 * an unambiguous catalog entry, or the Owner established it. A curated model
 * was measured answering a real chat completion, so the Owner establishes it
 * here. Without this the curated rows stay unknown and every client that
 * filters on chat support (pi's iroha extension) drops them from its list,
 * even though the Gateway can route them.
 *
 * The override replaces the whole override object, so the existing one is
 * merged rather than discarded.
 */
const ensureChatEvidence = async (
  providerId: string,
  models: readonly string[],
  catalog: readonly CatalogEntry[],
): Promise<readonly string[]> => {
  const byId = new Map(catalog.map((entry) => [entry.modelId, entry]))
  const written: string[] = []
  for (const model of models) {
    const entry = byId.get(model)
    if (entry === undefined) continue
    if (entry.overrides?.chat === true) continue
    await admin('PATCH', `/providers/${providerId}/catalog/models/${encodeURIComponent(model)}`, {
      overrides: { ...(entry.overrides ?? {}), chat: true },
    })
    written.push(model)
  }
  return written
}

/**
 * Turns on the failover for an endpoint that cannot be reached.
 *
 * A curated Provider holds several endpoints for one model, because a relay
 * dies and the model must not. With the setting off, a dead endpoint ends the
 * request with 502 even when a second endpoint serves the same model: the
 * network failure is ambiguous, so the Gateway refuses to spend an attempt.
 * The stock Providers carry the setting; the curated ones did not, which is
 * why a single dead relay took whole models down.
 */
const ensureFailover = async (providerId: string, current: ProviderDto | undefined): Promise<boolean> => {
  if (current?.retryAmbiguousNetwork === true) return false
  await admin('PATCH', `/providers/${providerId}`, { retryAmbiguousNetwork: true })
  return true
}

const sameModels = (a: readonly string[] | null, b: readonly string[]): boolean => {
  const left = [...(a ?? [])].sort()
  const right = [...b].sort()
  return left.length === right.length && left.every((value, index) => value === right[index])
}

const sameRewrites = (
  a: Record<string, string> | null,
  b: Record<string, string>,
): boolean => {
  const left = a ?? {}
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(b).sort()
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === b[key])
  )
}

const verify = async (handle: string, providerId: string, models: readonly string[]): Promise<void> => {
  const ok: string[] = []
  const failed: string[] = []
  for (const model of models) {
    const { status, json } = await request('POST', `/providers/${providerId}/test`, {
      model,
      protocol: 'openai',
    })
    if (status === 200) {
      ok.push(model)
    } else {
      const message = json?.error?.message ?? JSON.stringify(json).slice(0, 90)
      failed.push(`${model} (${status} ${message})`)
    }
  }
  console.log(`\n  verify ${handle}: ${ok.length}/${models.length} answer`)
  for (const model of ok) console.log(`    ok    ${model}`)
  for (const model of failed) console.log(`    FAIL  ${model}`)
}

const main = async (): Promise<void> => {
  const providers = await listing()
  const byHandle = new Map(providers.map((p) => [p.handle, p]))
  const gatewayKeys = await admin('GET', '/gateway-keys')
  const keys: GatewayKeyDto[] = gatewayKeys.gatewayKeys ?? gatewayKeys.keys ?? gatewayKeys.data ?? []

  const replacedProviderIds = new Map<string, string>()
  const report: string[] = []
  const problems: string[] = []

  // The snapshot is taken before anything is written: the purge that frees a
  // handle is the one step that cannot be undone.
  if (APPLY && MODE === 'rebuild') {
    await snapshot(providers)
  }

  for (const [handle, wanted] of Object.entries(plan.providers)) {
    const current = byHandle.get(handle)
    if (!current) {
      problems.push(`${handle}: no Provider with that handle exists`)
      continue
    }
    if (current.archived) {
      problems.push(`${handle}: Provider is archived`)
      continue
    }
    if (wanted.models.length === 0) {
      report.push(
        `\n### ${handle}  (${current.id})\n  nothing answers for this family right now — left untouched`,
      )
      continue
    }

    const currentKeys = new Map(
      (current.keys ?? []).map((k) => [k.baseUrl ?? current.baseUrl, k]),
    )
    const wantedUrls = new Set(wanted.keys.map((k) => k.baseUrl))

    const drop = [...currentKeys.keys()].filter((url) => !wantedUrls.has(url))
    const add = wanted.keys.filter((k) => !currentKeys.has(k.baseUrl))
    const keep = wanted.keys.filter((k) => currentKeys.has(k.baseUrl))

    const catalog = await catalogOf(current.id)
    const ownerAdded = catalog.filter((e) => e.source === 'owner_added')
    const discovered = catalog.filter((e) => e.source === 'discovered')
    const staleOwner = ownerAdded.filter((e) => !wanted.models.includes(e.modelId))
    const missingModels = wanted.models.filter(
      (m) => !ownerAdded.some((e) => e.modelId === m),
    )

    report.push(`\n### ${handle}  (${current.id})`)
    report.push(`  keys: keep ${keep.length}, add ${add.length}, drop ${drop.length}`)
    for (const k of add) report.push(`    + ${k.baseUrl}`)
    for (const url of drop) report.push(`    - ${url}`)
    report.push(
      `  catalog: ${catalog.length} entries (${ownerAdded.length} owner, ${discovered.length} discovered)`,
    )
    report.push(`    models to add: ${missingModels.length} ${JSON.stringify(missingModels)}`)
    report.push(`    owner models to drop: ${staleOwner.length} ${JSON.stringify(staleOwner.map((e) => e.modelId))}`)
    const withoutChatEvidence = wanted.models.filter((model) => {
      const entry = catalog.find((e) => e.modelId === model)
      return entry !== undefined && entry.overrides?.chat !== true
    })
    report.push(
      `    chat evidence to establish: ${withoutChatEvidence.length}` +
        (withoutChatEvidence.length > 0 ? ` ${JSON.stringify(withoutChatEvidence)}` : ''),
    )
    if (discovered.length > 0) {
      report.push(
        `    discovered entries: ${discovered.length}` +
          (MODE === 'rebuild' ? ' (cleared by the purge)' : ' (CANNOT be removed by the API)'),
      )
    }
    for (const k of keep) {
      const existing = currentKeys.get(k.baseUrl)!
      if (!sameModels(existing.allowedModels, k.allowedModels)) {
        report.push(`    ~ ${k.baseUrl}: allowedModels ${JSON.stringify(existing.allowedModels)} -> ${JSON.stringify(k.allowedModels)}`)
      }
      if (!sameRewrites(existing.modelRewrites, k.modelRewrites)) {
        report.push(`    ~ ${k.baseUrl}: modelRewrites -> ${JSON.stringify(k.modelRewrites)}`)
      }
    }

    if (!APPLY) continue

    if (MODE === 'rebuild') {
      // Archive first (reversible), then purge (not): the purge is what frees
      // the handle and cascades the stale catalog and availability away.
      await admin('POST', `/providers/${current.id}/archive`)
      await admin('POST', `/providers/${current.id}/purge`)
      const created = await admin('POST', '/providers', {
        handle,
        displayName: `${handle} (Relay Hunt curated)`,
        baseUrl: current.baseUrl,
        templateId: 'generic-openai-compatible',
        requiresUpstreamKey: false,
        allowInsecureHttp: true,
        modelDiscovery: 'unsupported',
        keys: wanted.keys.map((k) => ({
          upstreamKey: '',
          baseUrl: k.baseUrl,
          modelRewrites: k.modelRewrites,
        })),
      })
      replacedProviderIds.set(current.id, created.id)
      report.push(`  rebuilt: ${current.id} -> ${created.id}`)
      // A created Provider starts with the failover off, so it is turned on
      // here rather than left to the Owner's next visit.
      await ensureFailover(created.id, undefined)
      report.push('  failover on unreachable endpoints: enabled')

      for (const k of wanted.keys) {
        const createdKey = (created.keys ?? []).find(
          (c: ProviderDto['keys'][number]) => c.baseUrl === k.baseUrl,
        )
        if (!createdKey) {
          problems.push(`${handle}: key not found after create: ${k.baseUrl}`)
          continue
        }
        await admin('PATCH', `/providers/${created.id}/keys/${createdKey.id}`, {
          allowedModels: k.allowedModels,
          modelRewrites: k.modelRewrites,
        })
      }
      for (const model of wanted.models) {
        await admin('POST', `/providers/${created.id}/catalog/models`, { modelId: model })
      }
      const createdCatalog = await catalogOf(created.id)
      const withChat = await ensureChatEvidence(created.id, wanted.models, createdCatalog)
      report.push(`  chat evidence established on ${withChat.length} models ${JSON.stringify(withChat)}`)
    } else {
      for (const url of drop) {
        const key = currentKeys.get(url)!
        await admin('DELETE', `/providers/${current.id}/keys/${key.id}`)
        report.push(`  dropped key ${key.id} (${url})`)
      }
      for (const k of add) {
        await admin('POST', `/providers/${current.id}/keys`, {
          upstreamKey: '',
          baseUrl: k.baseUrl,
          allowedModels: k.allowedModels,
          modelRewrites: k.modelRewrites,
        })
        report.push(`  added key ${k.baseUrl}`)
      }
      for (const k of keep) {
        const key = currentKeys.get(k.baseUrl)!
        await admin('PATCH', `/providers/${current.id}/keys/${key.id}`, {
          allowedModels: k.allowedModels,
          modelRewrites: k.modelRewrites,
        })
      }
      for (const entry of staleOwner) {
        await admin('DELETE', `/providers/${current.id}/catalog/models/${encodeURIComponent(entry.modelId)}`)
        report.push(`  dropped catalog model ${entry.modelId}`)
      }
      for (const model of missingModels) {
        await admin('POST', `/providers/${current.id}/catalog/models`, { modelId: model })
      }
      const freshCatalog = await catalogOf(current.id)
      const withChat = await ensureChatEvidence(current.id, wanted.models, freshCatalog)
      report.push(`  chat evidence established on ${withChat.length} models ${JSON.stringify(withChat)}`)
      if (await ensureFailover(current.id, current)) {
        report.push('  failover on unreachable endpoints: enabled')
      }
    }
  }

  // Scoped Gateway Keys name a Provider id. A rebuild changes that id, so the
  // key is replaced with one that names the new id, and the old one revoked.
  if (APPLY && MODE === 'rebuild' && replacedProviderIds.size > 0) {
    for (const key of keys) {
      const scope = key.access?.providers ?? key.scope ?? []
      const touched = scope.filter((entry) => replacedProviderIds.has(entry.providerId))
      if (touched.length === 0) continue
      const replacement = await admin('POST', '/gateway-keys', {
        name: key.name,
        scope: scope.map((entry) => ({
          providerId: replacedProviderIds.get(entry.providerId) ?? entry.providerId,
          models: entry.models,
        })),
      })
      await admin('POST', `/gateway-keys/${key.id}/revoke`)
      report.push(
        `\n  gateway key ${key.id} (${key.name}) replaced by ${replacement.id}` +
          ` — new secret, shown once: ${replacement.secret ?? '(not returned)'}`,
      )
    }
  }

  console.log(report.join('\n'))
  if (problems.length > 0) {
    console.log('\nPROBLEMS:')
    for (const problem of problems) console.log('  ' + problem)
  }
  if (!APPLY) {
    console.log('\nDry run. Pass --apply to write.')
    return
  }
  if (VERIFY) {
    const after = await listing()
    for (const [handle, wanted] of Object.entries(plan.providers)) {
      const provider = after.find((p) => p.handle === handle)
      if (!provider) continue
      await verify(handle, provider.id, wanted.models)
    }
  }
}

await main()
