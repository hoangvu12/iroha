/**
 * Imports relay-hunt win hosts as iroha Providers: one Provider per host, one
 * Upstream Key per endpoint, canonical model IDs shared across hosts through
 * per-key `modelRewrites` (ADR-0028).
 *
 * Input: relay-hunt's `pool/import-manifest.json`
 *   hosts[].host / scheme / baseUrl      endpoint under test
 *   hosts[].verified[].catalogue         canonical gateway id (null = skip row)
 *   hosts[].verified[].requested         the exact id that answered 200 + text
 *   hosts[].catalogue_ids                deduped canonical ids for this host
 *
 * Rules this script holds itself to:
 *   - Additive only. No deletes, no archives, no migrations, no touching keys
 *     it did not create or extend.
 *   - Dedupe by endpoint, not by name: an existing Provider whose base URL host
 *     matches is reused; an existing Key whose effective base URL matches is
 *     extended, never duplicated.
 *   - Each Provider's `baseUrl` carries `/v1`, because the Generic adapter joins
 *     it to `/chat/completions` verbatim (`upstreamUrl`).
 *   - `modelRewrites` maps canonical id -> the exact spelling that endpoint
 *     accepted. Rows where the two are equal need no entry.
 *   - Dry run by default. `--apply` writes. A second `--apply` changes nothing.
 *
 * Usage:
 *   bun run scripts/import-relay-hunt-wins.ts <manifest.json> [options]
 *
 *   --apply              write to the admin API (default: plan only)
 *   --verify             after writing, one inference per endpoint through
 *                        iroha's own gateway, using a temporary Gateway Key
 *                        that is revoked and deleted afterwards
 *   --base-url <url>     admin surface (default https://iroha.nguyenvu.dev)
 *   --only <substr>      restrict to endpoints whose host contains <substr>
 *   --json <path>        machine-readable result (default .scratch/relay-import/result.json)
 *   --report <path>      markdown report (default .scratch/relay-import/report.md)
 *
 * Auth: `IROHA_ADMIN_KEY` from the environment or the repo `.env`, scope
 * `admin:write`. The key is never printed and never reaches the report.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const ADMIN_TIMEOUT_MS = 120_000

interface ManifestRow {
  readonly upstream: string
  readonly catalogue: string | null
  readonly score: number
  readonly requested: string
}

interface ManifestHost {
  readonly host: string
  readonly scheme: string
  readonly baseUrl: string
  readonly win_model?: string
  readonly verified: readonly ManifestRow[]
  readonly catalogue_ids: readonly string[]
}

interface Manifest {
  readonly generatedAt: string
  readonly source: string
  readonly hosts: readonly ManifestHost[]
}

/** One endpoint we intend to exist in iroha: a base URL plus its model shelf. */
interface DesiredEndpoint {
  /** `hostname:port`, the identity used for dedupe. */
  readonly endpointId: string
  readonly hostname: string
  readonly port: string
  readonly scheme: string
  /** Base URL with `/v1`, ready for the adapter. */
  readonly baseUrl: string
  readonly canonicalIds: readonly string[]
  readonly rewrites: Readonly<Record<string, string>>
  /** Highest-scoring canonical id on this endpoint, the one to prove it with. */
  readonly primaryModel: string
  /** Every canonical id, best catalogue score first, for a verification retry. */
  readonly rankedModels: readonly string[]
  /** Canonical -> proven wire spelling, for the report. */
  readonly chosen: Readonly<Record<string, { native: string; alternates: string[] }>>
  readonly verifiedCount: number
  readonly skippedRows: number
}

interface DesiredProvider {
  readonly hostname: string
  readonly handle: string
  readonly displayName: string
  readonly primary: DesiredEndpoint
  readonly endpoints: readonly DesiredEndpoint[]
  readonly allowInsecureHttp: boolean
}

type Outcome =
  | { readonly kind: 'provider_created'; readonly handle: string; readonly providerId: string; readonly endpoints: number; readonly models: number }
  | { readonly kind: 'provider_reused'; readonly handle: string; readonly providerId: string; readonly note: string }
  | { readonly kind: 'endpoint_added'; readonly handle: string; readonly providerId: string; readonly endpointId: string; readonly keyId: string; readonly models: number }
  | { readonly kind: 'endpoint_extended'; readonly handle: string; readonly providerId: string; readonly endpointId: string; readonly keyId: string; readonly modelsAdded: string[]; readonly rewritesAdded: string[] }
  | { readonly kind: 'endpoint_unchanged'; readonly handle: string; readonly providerId: string; readonly endpointId: string; readonly keyId: string }
  | { readonly kind: 'skipped'; readonly endpointId: string; readonly reason: string }
  | { readonly kind: 'failed'; readonly endpointId: string; readonly status: number; readonly code: string; readonly message: string; readonly problems?: readonly { field: string; message: string }[] }

interface AdminKeyView {
  readonly id: string
  readonly health: string
  readonly baseUrl: string | null
  readonly effectiveBaseUrl: string
  readonly allowedModels: readonly string[] | null
  readonly modelRewrites: Readonly<Record<string, string>> | null
}

interface AdminProviderView {
  readonly id: string
  readonly handle: string
  readonly displayName: string
  readonly baseUrl: string
  readonly enabled: boolean
  readonly archived: boolean
  readonly keys: readonly AdminKeyView[]
}

interface VerifyResult {
  readonly handle: string
  readonly endpointId: string
  readonly model: string
  readonly status: number
  readonly ok: boolean
  readonly served: string | null
  readonly text: string
  readonly error: string | null
}

const args = process.argv.slice(2)
const flag = (name: string): boolean => args.includes(`--${name}`)
const option = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}

const APPLY = flag('apply')
const VERIFY = flag('verify')
const VERIFY_ATTEMPTS = Math.max(1, Number(option('verify-attempts') ?? 3) || 3)
const ADMIN_BASE = (option('base-url') ?? 'https://iroha.nguyenvu.dev').replace(/\/+$/, '')
const ONLY = option('only')
/**
 * Hosts forced onto a Provider of their own. Use when an existing Provider owns
 * the host but cannot route the ids we need: its stored Key Model Availability
 * gates every model the allow-list admits, and only discovery widens it.
 */
/**
 * Endpoints to leave out, as `hostname:port`. Used when the manifest's scheme
 * is not the one the origin actually serves: `http://host` that 308s to https
 * is the same shelf as the https endpoint, not a second one.
 */
const SKIP_ENDPOINTS = new Set(
  args.reduce<string[]>((acc: string[], value: string, index: number) => {
    const next = args[index + 1]
    if (value === '--skip-endpoint' && typeof next === 'string') acc.push(next.toLowerCase())
    return acc
  }, []),
)

const FRESH_HOSTS = new Set(
  args.reduce<string[]>((acc: string[], value: string, index: number) => {
    const next = args[index + 1]
    if (value === '--fresh' && typeof next === 'string') acc.push(next)
    return acc
  }, []),
)
const JSON_PATH = resolve(option('json') ?? '.scratch/relay-import/result.json')
const REPORT_PATH = resolve(option('report') ?? '.scratch/relay-import/report.md')
const manifestPathArg = args.find((value: string) => !value.startsWith('--') && !isOptionValue(value))
  ?? '../relay-hunt/pool/import-manifest.json'
const MANIFEST_PATH = resolve(manifestPathArg)

function isOptionValue(value: string): boolean {
  const index = args.indexOf(value)
  if (index <= 0) return false
  return ['--base-url', '--only', '--json', '--report', '--fresh', '--skip-endpoint', '--verify-attempts'].includes(args[index - 1] as string)
}

// ---------------------------------------------------------------------------
// Configuration and transport
// ---------------------------------------------------------------------------

async function readAdminKey(): Promise<string> {
  const fromEnv = process.env.IROHA_ADMIN_KEY
  if (fromEnv && fromEnv.length > 0) return fromEnv

  try {
    for (const line of (await readFile(resolve('.env'), 'utf8')).split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('IROHA_ADMIN_KEY=')) continue
      const value = trimmed.slice('IROHA_ADMIN_KEY='.length).trim().replace(/^["']|["']$/g, '')
      if (value.length > 0) return value
    }
  } catch {
    // No readable .env; the caller gets the error below.
  }
  throw new Error('IROHA_ADMIN_KEY is not set in the environment or .env')
}

interface AdminResponse {
  readonly status: number
  readonly body: unknown
}

let adminKey = ''

/**
 * One admin call. No `Origin` header: the owner guard rejects a foreign one and
 * permits its absence, which is the only shape a script can produce safely.
 */
async function admin(method: string, path: string, body?: unknown): Promise<AdminResponse> {
  const payload = body === undefined ? null : JSON.stringify(body)
  const init: RequestInit = {
    method,
    headers: {
      authorization: `Bearer ${adminKey}`,
      accept: 'application/json',
      ...(payload === null ? {} : { 'content-type': 'application/json' }),
    },
    signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS),
    ...(payload === null ? {} : { body: payload }),
  }
  const response = await fetch(`${ADMIN_BASE}/api/v1/admin${path}`, init)

  const text = await response.text()
  let parsed: unknown = null
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { raw: text.slice(0, 400) }
    }
  }
  return { status: response.status, body: parsed }
}

function failureOf(response: AdminResponse): { code: string; message: string; problems?: { field: string; message: string }[] } {
  const body = response.body as { error?: { code?: unknown; message?: unknown; problems?: unknown } } | null
  const error = body?.error ?? {}
  const problems = Array.isArray(error.problems)
    ? (error.problems as { field: string; message: string }[]).filter(
        (entry) => typeof entry?.field === 'string' && typeof entry?.message === 'string',
      )
    : undefined
  return {
    code: typeof error.code === 'string' ? error.code : `http_${response.status}`,
    message: typeof error.message === 'string' ? error.message : JSON.stringify(response.body ?? null).slice(0, 300),
    ...(problems && problems.length > 0 ? { problems } : {}),
  }
}

// ---------------------------------------------------------------------------
// Manifest -> desired state
// ---------------------------------------------------------------------------

function endpointIdOf(raw: string): { hostname: string; port: string; endpointId: string } {
  const url = new URL(raw.includes('://') ? raw : `https://${raw}`)
  const hostname = url.hostname.toLowerCase()
  const port = url.port.length > 0 ? url.port : url.protocol === 'http:' ? '80' : '443'
  return { hostname, port, endpointId: `${hostname}:${port}` }
}

/** The adapter joins baseUrl to `/chat/completions` verbatim, so `/v1` belongs in the stored URL. */
function withV1(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`
}

/**
 * Picks the wire spelling for one canonical id. Tiers, best first:
 *   0. requested === canonical id            (no rewrite at all)
 *   1. bare id, no slash                     (stable native spelling)
 *   2. prefixed id, e.g. `claude/claude-fable-5`
 *   3. an `auto/*` router combo              (proven, but resolves dynamically)
 * Ties keep the shortest string, then the lowest catalogue delta.
 */
function tier(requested: string, catalogue: string): number {
  if (requested === catalogue) return 0
  if (!requested.includes('/')) return 1
  if (requested.startsWith('auto/')) return 3
  return 2
}

function describeEndpoint(entry: ManifestHost): DesiredEndpoint {
  const { hostname, port, endpointId } = endpointIdOf(entry.baseUrl)
  const byCanonical = new Map<string, { native: string; alternates: string[]; score: number }>()
  let skippedRows = 0

  for (const row of entry.verified) {
    const catalogue = row.catalogue
    if (!catalogue || catalogue.length === 0) {
      skippedRows += 1
      continue
    }
    // `requested` is the string that produced 200 + text; `upstream` is what the
    // response body claimed, which is not necessarily an accepted input.
    const native = row.requested
    const existing = byCanonical.get(catalogue)
    if (!existing) {
      byCanonical.set(catalogue, { native, alternates: row.upstream !== native ? [row.upstream] : [], score: row.score })
      continue
    }

    if (row.upstream !== native && !existing.alternates.includes(row.upstream)) existing.alternates.push(row.upstream)

    const candidateTier = tier(native, catalogue)
    const existingTier = tier(existing.native, catalogue)
    const better =
      candidateTier < existingTier ||
      (candidateTier === existingTier &&
        (native.length < existing.native.length ||
          (native.length === existing.native.length && row.score > existing.score)))
    if (better) {
      if (existing.native !== native) existing.alternates.push(existing.native)
      existing.native = native
      existing.score = row.score
    }
  }

  const canonicalIds = [...byCanonical.keys()].sort()
  const rankedModels = [...byCanonical.entries()]
    .sort((left, right) => right[1].score - left[1].score || left[0].localeCompare(right[0]))
    .map(([model]) => model)
  const primaryModel = rankedModels[0] ?? ''
  const rewrites: Record<string, string> = {}
  const chosen: Record<string, { native: string; alternates: string[] }> = {}
  for (const [catalogue, value] of byCanonical) {
    if (value.native !== catalogue) rewrites[catalogue] = value.native
    chosen[catalogue] = {
      native: value.native,
      alternates: [...new Set(value.alternates.filter((entry) => entry.length > 0 && entry !== value.native))].sort(),
    }
  }

  return {
    endpointId,
    hostname,
    port,
    scheme: entry.scheme,
    baseUrl: withV1(entry.baseUrl),
    canonicalIds,
    rewrites,
    primaryModel,
    rankedModels,
    chosen,
    verifiedCount: entry.verified.length - skippedRows,
    skippedRows,
  }
}

function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '')
}

function desiredProviders(manifest: Manifest): DesiredProvider[] {
  const byHostname = new Map<string, DesiredEndpoint[]>()
  let skippedHosts = 0

  for (const entry of manifest.hosts) {
    if (ONLY && !entry.host.includes(ONLY)) continue
    const endpoint = describeEndpoint(entry)
    if (SKIP_ENDPOINTS.has(endpoint.endpointId)) {
      console.log(`[skip] ${endpoint.endpointId}: excluded by --skip-endpoint`)
      continue
    }
    if (endpoint.canonicalIds.length === 0) {
      skippedHosts += 1
      console.log(`[skip] ${endpoint.endpointId}: no verified id has a catalogue row`)
      continue
    }
    const existing = byHostname.get(endpoint.hostname) ?? []
    existing.push(endpoint)
    byHostname.set(endpoint.hostname, existing)
  }

  if (skippedHosts > 0) console.log(`[plan] ${skippedHosts} host(s) skipped: nothing to share a gateway id on`)

  const providers: DesiredProvider[] = []
  for (const [hostname, endpoints] of byHostname) {
    // The primary endpoint is the one with the largest shelf; ties prefer https.
    const sorted = [...endpoints].sort((left, right) => {
      if (right.canonicalIds.length !== left.canonicalIds.length) return right.canonicalIds.length - left.canonicalIds.length
      if (left.scheme !== right.scheme) return left.scheme === 'https' ? -1 : 1
      return left.port.localeCompare(right.port)
    })
    const primary = sorted[0] as DesiredEndpoint
    const nonStandard = primary.port !== (primary.scheme === 'https' ? '443' : '80')
    providers.push({
      hostname,
      handle: `relay-${slug(hostname)}${nonStandard ? `-${primary.port}` : ''}`,
      displayName: hostname,
      primary,
      endpoints: sorted,
      allowInsecureHttp: sorted.some((endpoint) => endpoint.scheme === 'http'),
    })
  }

  return providers.sort((left, right) => left.hostname.localeCompare(right.hostname))
}

// ---------------------------------------------------------------------------
// Existing state
// ---------------------------------------------------------------------------

async function listProviders(): Promise<AdminProviderView[]> {
  const response = await admin('GET', '/providers')
  if (response.status !== 200) {
    const failure = failureOf(response)
    throw new Error(`GET /providers failed: ${response.status} ${failure.code} ${failure.message}`)
  }
  const body = response.body as { providers?: unknown } | null
  const providers = Array.isArray(body?.providers) ? (body?.providers as AdminProviderView[]) : []
  return providers
}

/**
 * Host -> Provider for Provider-level base URLs. A host may be claimed twice
 * when an older Provider cannot route the host's shelf and an imported one was
 * created for it; the imported `relay-` Provider wins, so a rerun extends the
 * shelf that actually works instead of re-adding keys to the broken one.
 */
function indexByHostname(providers: readonly AdminProviderView[]): Map<string, AdminProviderView> {
  const index = new Map<string, AdminProviderView>()
  for (const provider of providers) {
    let hostname: string
    try {
      hostname = endpointIdOf(provider.baseUrl).hostname
    } catch {
      continue
    }
    const held = index.get(hostname)
    if (held === undefined || (!held.handle.startsWith('relay-') && provider.handle.startsWith('relay-'))) {
      index.set(hostname, provider)
    }
  }
  return index
}

/**
 * Host -> Provider for every endpoint that already exists, including hosts that
 * live as one Key's `baseUrl` under a Provider named for a different host. The
 * `muse` Provider already owns a key for a relay this manifest lists, and
 * creating a second Provider for that host would be the duplication to avoid.
 */
function indexByEndpointHost(providers: readonly AdminProviderView[]): Map<string, AdminProviderView> {
  const index = new Map<string, AdminProviderView>()
  for (const provider of providers) {
    for (const key of provider.keys) {
      let hostname: string
      try {
        hostname = endpointIdOf(key.effectiveBaseUrl).hostname
      } catch {
        continue
      }
      const held = index.get(hostname)
      if (held === undefined || (!held.handle.startsWith('relay-') && provider.handle.startsWith('relay-'))) {
        index.set(hostname, provider)
      }
    }
  }
  return index
}

function keyForEndpoint(provider: AdminProviderView, endpoint: DesiredEndpoint): AdminKeyView | undefined {
  return provider.keys.find((key) => {
    try {
      return endpointIdOf(key.effectiveBaseUrl).endpointId === endpoint.endpointId
    } catch {
      return false
    }
  })
}

/** `logoDomain` accepts a hostname or an HTTP(S) URL, not a bare IP literal. */
function logoDomainFor(hostname: string): string | undefined {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')
    ? undefined
    : hostname
}

function uniqueHandle(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base.slice(0, 58)}-${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base.slice(0, 52)}-${Date.now().toString(36)}`
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function createProvider(
  desired: DesiredProvider,
  handle: string,
): Promise<{ ok: true; provider: AdminProviderView } | { ok: false; failure: ReturnType<typeof failureOf>; status: number }> {
  const primary = desired.primary
  const response = await admin('POST', '/providers', {
    handle,
    displayName: desired.displayName,
    baseUrl: primary.baseUrl,
    ...(logoDomainFor(desired.hostname) === undefined ? {} : { logoDomain: logoDomainFor(desired.hostname) }),
    allowInsecureHttp: desired.allowInsecureHttp,
    requiresUpstreamKey: false,
    // These relays serve a fixed shelf and mostly 401 `/v1/models`; discovery off
    // keeps the key's eligibility exactly the allow-list this script writes.
    modelDiscovery: 'unsupported',
    keys: [{ upstreamKey: '', modelRewrites: primary.rewrites }],
  })

  const body = response.body as { error?: unknown; provider?: unknown } | null
  const created = (body as { provider?: AdminProviderView } | null)?.provider
    ?? (response.status === 201 && body && 'id' in (body as object) ? (body as unknown as AdminProviderView) : undefined)

  if (response.status !== 201 || !created) {
    return { ok: false, failure: failureOf(response), status: response.status }
  }
  return { ok: true, provider: created }
}

async function patchKey(
  providerId: string,
  key: AdminKeyView,
  nextAllowed: readonly string[],
  nextRewrites: Readonly<Record<string, string>>,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await admin('PATCH', `/providers/${providerId}/keys/${key.id}`, {
    allowedModels: nextAllowed,
    modelRewrites: nextRewrites,
  })
  return { ok: response.status === 200, status: response.status, body: response.body }
}

async function addKey(
  providerId: string,
  endpoint: DesiredEndpoint,
): Promise<{ ok: true; provider: AdminProviderView } | { ok: false; failure: ReturnType<typeof failureOf>; status: number }> {
  const response = await admin('POST', `/providers/${providerId}/keys`, {
    upstreamKey: '',
    // Always explicit: a Provider's own base URL may be another endpoint's.
    baseUrl: endpoint.baseUrl,
    allowedModels: endpoint.canonicalIds,
    modelRewrites: endpoint.rewrites,
  })
  const body = response.body as { provider?: AdminProviderView } | null
  const provider = body?.provider ?? (response.status === 201 ? (body as unknown as AdminProviderView) : undefined)
  if (response.status !== 201 || !provider) {
    return { ok: false, failure: failureOf(response), status: response.status }
  }
  return { ok: true, provider }
}

function mergedModels(existing: readonly string[] | null, wanted: readonly string[]): { next: string[]; added: string[] } {
  const set = new Set(existing ?? [])
  const added: string[] = []
  for (const model of wanted) {
    if (set.has(model)) continue
    set.add(model)
    added.push(model)
  }
  return { next: [...set].sort(), added }
}

function mergedRewrites(
  existing: Readonly<Record<string, string>> | null,
  wanted: Readonly<Record<string, string>>,
): { next: Record<string, string>; added: string[] } {
  const next: Record<string, string> = { ...(existing ?? {}) }
  const added: string[] = []
  for (const [canonical, native] of Object.entries(wanted)) {
    // Never overwrite a mapping somebody already relied on.
    if (canonical in next) continue
    next[canonical] = native
    added.push(canonical)
  }
  return { next, added }
}

// ---------------------------------------------------------------------------
// Verification through iroha's own gateway
// ---------------------------------------------------------------------------

function servedModel(body: unknown): string | null {
  const record = body as { model?: unknown; choices?: unknown } | null
  if (typeof record?.model === 'string') return record.model
  return null
}

function completionText(body: unknown): string {
  const record = body as { choices?: { message?: { content?: unknown } }[] } | null
  const content = record?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content.slice(0, 60)
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : ''))
      .join('')
    return text.slice(0, 60)
  }
  return ''
}

async function verifyEndpoints(desired: readonly DesiredProvider[]): Promise<VerifyResult[]> {
  // `POST /api/v1/admin/providers/:id/test` runs a real inference through the
  // Owner session pinned to one Provider, so no Gateway Key is minted and the
  // per-key rewrite is exercised exactly as production routing would.
  const providers = await listProviders()
  const byHostname = indexByHostname(providers)
  const byEndpointHost = indexByEndpointHost(providers)
  const results: VerifyResult[] = []

  for (const provider of desired) {
    const byBase = byHostname.get(provider.hostname)
    const reuse = byBase ?? byEndpointHost.get(provider.hostname)
    // A --fresh host gets a Provider of its own: prefer the one named for it.
    const fresh = [...providers].reverse().find((candidate) => candidate.handle.startsWith(provider.handle))
    const found = FRESH_HOSTS.has(provider.hostname) ? fresh : reuse
    if (!found) {
      results.push({
        handle: provider.handle,
        endpointId: provider.primary.endpointId,
        model: provider.primary.primaryModel,
        status: 0,
        ok: false,
        served: null,
        text: '',
        error: 'provider not found after apply',
      })
      continue
    }

    for (const endpoint of provider.endpoints) {
      const models = endpoint.rankedModels.slice(0, VERIFY_ATTEMPTS)
      if (models.length === 0) {
        results.push({ handle: found.handle, endpointId: endpoint.endpointId, model: '', status: 0, ok: false, served: null, text: '', error: 'no canonical id' })
        continue
      }

      // One attempt per candidate id, best score first, stopping at the first
      // success. A relay whose own upstream account is out of credits on its
      // top model still answers on a cheaper one, and that is worth knowing.
      for (const model of models) {
        let result: VerifyResult
        try {
          const response = await admin('POST', `/providers/${found.id}/test`, { model, protocol: 'openai' })
          const parsed = response.body
          const errorBody = parsed as { error?: { message?: unknown } } | null
          result = {
            handle: found.handle,
            endpointId: endpoint.endpointId,
            model,
            status: response.status,
            ok: response.status === 200 && completionText(parsed).length > 0,
            served: servedModel(parsed),
            text: completionText(parsed),
            error:
              response.status === 200
                ? null
                : typeof errorBody?.error?.message === 'string'
                  ? errorBody.error.message.slice(0, 200)
                  : JSON.stringify(parsed ?? null).slice(0, 200),
          }
        } catch (cause) {
          result = {
            handle: found.handle,
            endpointId: endpoint.endpointId,
            model,
            status: 0,
            ok: false,
            served: null,
            text: '',
            error: cause instanceof Error ? cause.message : String(cause),
          }
        }
        results.push(result)
        console.log(`[verify] ${found.handle.padEnd(44).slice(0, 44)} ${model.padEnd(24).slice(0, 24)} ${result.status} ${result.ok ? 'ok' : 'no'}`)
        if (result.ok) break
      }
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function markdownReport(
  manifest: Manifest,
  desired: readonly DesiredProvider[],
  outcomes: readonly Outcome[],
  verification: readonly VerifyResult[],
  providers: readonly AdminProviderView[],
): string {
  const count = (kind: Outcome['kind']): number => outcomes.filter((entry) => entry.kind === kind).length
  const endpoints = desired.reduce((total, provider) => total + provider.endpoints.length, 0)
  const rewrites = desired.reduce(
    (total, provider) => total + provider.endpoints.reduce((inner, endpoint) => inner + Object.keys(endpoint.rewrites).length, 0),
    0,
  )
  const canonical = new Set(desired.flatMap((provider) => provider.endpoints.flatMap((endpoint) => endpoint.canonicalIds)))

  const lines: string[] = []
  lines.push('# relay-hunt → iroha import')
  lines.push('')
  lines.push(`Manifest: \`${MANIFEST_PATH}\` (generated ${manifest.generatedAt})`)
  lines.push(`Admin surface: \`${ADMIN_BASE}\``)
  lines.push(`Mode: ${APPLY ? 'applied' : 'dry run'}`)
  lines.push('')
  lines.push('## Numbers')
  lines.push('')
  lines.push('| quantity | value |')
  lines.push('|---|---|')
  lines.push(`| endpoints in plan | ${endpoints} |`)
  lines.push(`| providers in plan | ${desired.length} |`)
  lines.push(`| distinct canonical ids | ${canonical.size} |`)
  lines.push(`| rewrite entries | ${rewrites} |`)
  lines.push(`| providers created | ${count('provider_created')} |`)
  lines.push(`| providers reused | ${count('provider_reused')} |`)
  lines.push(`| endpoints added | ${count('endpoint_added')} |`)
  lines.push(`| endpoints extended | ${count('endpoint_extended')} |`)
  lines.push(`| endpoints unchanged | ${count('endpoint_unchanged')} |`)
  lines.push(`| skipped | ${count('skipped')} |`)
  lines.push(`| failed | ${count('failed')} |`)
  lines.push(`| providers now in iroha | ${providers.length} |`)
  lines.push('')

  lines.push('## Dedupe')
  lines.push('')
  lines.push('| host | provider | endpoints | canonical ids |')
  lines.push('|---|---|---|---|')
  for (const provider of desired) {
    const outcome = outcomes.find(
      (entry) => (entry.kind === 'provider_created' || entry.kind === 'provider_reused') && entry.handle.startsWith(provider.handle),
    )
    const label = outcome && 'providerId' in outcome ? `\`${outcome.handle}\` (${outcome.kind === 'provider_created' ? 'created' : 'reused'})` : '—'
    const ids = [...new Set(provider.endpoints.flatMap((endpoint) => endpoint.canonicalIds))].length
    lines.push(`| \`${provider.hostname}\` | ${label} | ${provider.endpoints.length} | ${ids} |`)
  }
  lines.push('')

  lines.push('## Model shelf')
  lines.push('')
  lines.push('| endpoint | canonical id | wire spelling | alternates |')
  lines.push('|---|---|---|---|')
  for (const provider of desired) {
    for (const endpoint of provider.endpoints) {
      for (const canonicalId of endpoint.canonicalIds) {
        const chosen = endpoint.chosen[canonicalId]
        if (!chosen) continue
        const spelled = chosen.native === canonicalId ? '_(identical)_' : `\`${chosen.native}\``
        const alternates = chosen.alternates.length > 0 ? chosen.alternates.map((entry) => `\`${entry}\``).join(', ') : '—'
        lines.push(`| \`${endpoint.endpointId}\` | \`${canonicalId}\` | ${spelled} | ${alternates} |`)
      }
    }
  }
  lines.push('')

  if (verification.length > 0) {
    lines.push('## Verification through iroha')
    lines.push('')
    lines.push('| provider | endpoint | model | status | served |')
    lines.push('|---|---|---|---|---|')
    for (const result of verification) {
      lines.push(
        `| \`${result.handle}\` | \`${result.endpointId}\` | \`${result.model}\` | ${result.status}${result.ok ? '' : ' ✗'} | ${result.served ? `\`${result.served}\`` : result.error ? `_${result.error.replace(/\|/g, '/')}_` : '—'} |`,
      )
    }
    lines.push('')
  }

  const defects = outcomes.filter((entry) => entry.kind === 'failed' || entry.kind === 'skipped')
  if (defects.length > 0) {
    lines.push('## Skipped and failed')
    lines.push('')
    for (const entry of defects) {
      if (entry.kind === 'skipped') {
        lines.push(`- \`${entry.endpointId}\` — skipped: ${entry.reason}`)
        continue
      }
      if (entry.kind === 'failed') {
        const problems = entry.problems?.map((problem) => `${problem.field}: ${problem.message}`).join('; ')
        lines.push(`- \`${entry.endpointId}\` — ${entry.status} ${entry.code}: ${entry.message}${problems ? ` (${problems})` : ''}`)
      }
    }
    lines.push('')
  }

  lines.push('## Per-key state')
  lines.push('')
  lines.push('| provider | key base URL | health | allowed models | rewrites |')
  lines.push('|---|---|---|---|---|')
  const touched = new Set(
    outcomes
      .map((entry) => ('providerId' in entry ? entry.providerId : ''))
      .filter((value) => value.length > 0),
  )
  for (const provider of providers) {
    if (touched.size > 0 && !touched.has(provider.id)) continue
    if (!provider.handle.startsWith('relay-') && provider.handle !== 'muse') continue
    for (const key of provider.keys) {
      lines.push(
        `| \`${provider.handle}\` | \`${key.effectiveBaseUrl}\` | ${key.health} | ${key.allowedModels?.length ?? 0} | ${key.modelRewrites ? Object.keys(key.modelRewrites).length : 0} |`,
      )
    }
  }
  lines.push('')

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  adminKey = await readAdminKey()

  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as Manifest
  const desired = desiredProviders(manifest)

  console.log(`[plan] ${desired.length} providers, ${desired.reduce((total, provider) => total + provider.endpoints.length, 0)} endpoints, from ${manifest.hosts.length} manifest hosts`)
  for (const provider of desired) {
    const ids = new Set(provider.endpoints.flatMap((endpoint) => endpoint.canonicalIds))
    console.log(
      `[plan] ${provider.handle.padEnd(46).slice(0, 46)} ${String(provider.endpoints.length).padStart(2)} ep  ${String(ids.size).padStart(3)} ids  ${provider.primary.baseUrl}`,
    )
  }

  const existing = await listProviders()
  const byHostname = indexByHostname(existing)
  const byEndpointHost = indexByEndpointHost(existing)
  const takenHandles = new Set(existing.map((provider) => provider.handle))
  console.log(`[state] ${existing.length} providers, ${byHostname.size} distinct hosts indexed, ${byEndpointHost.size} endpoint hosts`)

  const outcomes: Outcome[] = []

  for (const provider of desired) {
    // A Provider named for this host wins; otherwise one that already owns a
    // Key on this host is reused, so the host never gets two owners. A --fresh
    // host bypasses a foreign Provider (one this import did not create) that
    // owns the host but cannot route it; an imported `relay-` Provider is
    // always reused, which is what makes a rerun a no-op.
    const reuse = byHostname.get(provider.hostname) ?? byEndpointHost.get(provider.hostname)
    const foreign = reuse !== undefined && !reuse.handle.startsWith('relay-')
    const found = FRESH_HOSTS.has(provider.hostname) && foreign ? undefined : reuse

    if (!found) {
      if (!APPLY) {
        outcomes.push({ kind: 'provider_created', handle: provider.handle, providerId: '(dry-run)', endpoints: provider.endpoints.length, models: new Set(provider.endpoints.flatMap((endpoint) => endpoint.canonicalIds)).size })
        console.log(`[plan] create \`${provider.handle}\` (${provider.endpoints.length} endpoint(s))`)
        continue
      }

      const handle = uniqueHandle(provider.handle, takenHandles)
      const created = await createProvider(provider, handle)
      if (!created.ok) {
        outcomes.push({ kind: 'failed', endpointId: provider.primary.endpointId, status: created.status, ...created.failure })
        console.log(`[fail] create ${handle}: ${created.status} ${created.failure.code} ${created.failure.message}`)
        continue
      }

      takenHandles.add(handle)
      byHostname.set(provider.hostname, created.provider)
      const finalHandle = created.provider.handle
      const primaryKey = created.provider.keys[0]
      const primaryEndpoint = provider.primary

      // The create body cannot carry `allowedModels` (readCreateKeys reads only
      // the key, its base URL and its rewrites), so the shelf is written once
      // here, on the key the registry just seeded.
      if (primaryKey) {
        const rewrites = mergedRewrites(primaryKey.modelRewrites, primaryEndpoint.rewrites)
        const patched = await patchKey(created.provider.id, primaryKey, [...primaryEndpoint.canonicalIds].sort(), rewrites.next)
        if (!patched.ok) {
          const failure = failureOf({ status: patched.status, body: patched.body })
          outcomes.push({ kind: 'failed', endpointId: primaryEndpoint.endpointId, status: patched.status, ...failure })
          console.log(`[fail] configure ${finalHandle}/${primaryKey.id}: ${patched.status} ${failure.code} ${failure.message}`)
        }
      }

      outcomes.push({
        kind: 'provider_created',
        handle: finalHandle,
        providerId: created.provider.id,
        endpoints: provider.endpoints.length,
        models: new Set(provider.endpoints.flatMap((endpoint) => endpoint.canonicalIds)).size,
      })
      console.log(`[created] ${finalHandle} (${created.provider.id}) ${primaryEndpoint.baseUrl}`)

      // Every endpoint past the primary becomes its own key with a base URL override.
      for (const endpoint of provider.endpoints) {
        if (endpoint.endpointId === primaryEndpoint.endpointId) continue
        if (!APPLY) continue
        const added = await addKey(created.provider.id, endpoint)
        if (!added.ok) {
          outcomes.push({ kind: 'failed', endpointId: endpoint.endpointId, status: added.status, ...added.failure })
          console.log(`[fail] add key ${endpoint.endpointId}: ${added.status} ${added.failure.code} ${added.failure.message}`)
          continue
        }
        byHostname.set(provider.hostname, added.provider)
        const key = keyForEndpoint(added.provider, endpoint)
        outcomes.push({
          kind: 'endpoint_added',
          handle: finalHandle,
          providerId: created.provider.id,
          endpointId: endpoint.endpointId,
          keyId: key?.id ?? '',
          models: endpoint.canonicalIds.length,
        })
        console.log(`[key] ${finalHandle} += ${endpoint.endpointId} (${endpoint.canonicalIds.length} ids)`)
      }
      continue
    }

    outcomes.push({
      kind: 'provider_reused',
      handle: found.handle,
      providerId: found.id,
      note: found.archived ? 'archived' : 'live',
    })
    if (found.archived) {
      console.log(`[skip] ${provider.hostname}: existing provider \`${found.handle}\` is archived; not resurrecting it`)
      for (const endpoint of provider.endpoints) {
        outcomes.push({ kind: 'skipped', endpointId: endpoint.endpointId, reason: `provider \`${found.handle}\` is archived` })
      }
      continue
    }
    console.log(`[dedupe] ${provider.hostname} -> existing \`${found.handle}\` (${found.keys.length} keys)`)

    for (const endpoint of provider.endpoints) {
      const key = keyForEndpoint(found, endpoint)

      if (!key) {
        if (!APPLY) {
          outcomes.push({ kind: 'endpoint_added', handle: found.handle, providerId: found.id, endpointId: endpoint.endpointId, keyId: '(dry-run)', models: endpoint.canonicalIds.length })
          console.log(`[plan] add key ${found.handle} += ${endpoint.endpointId} (${endpoint.canonicalIds.length} ids)`)
          continue
        }
        const added = await addKey(found.id, endpoint)
        if (!added.ok) {
          outcomes.push({ kind: 'failed', endpointId: endpoint.endpointId, status: added.status, ...added.failure })
          console.log(`[fail] add key ${endpoint.endpointId}: ${added.status} ${added.failure.code} ${added.failure.message}`)
          continue
        }
        const fresh = keyForEndpoint(added.provider, endpoint)
        outcomes.push({
          kind: 'endpoint_added',
          handle: found.handle,
          providerId: found.id,
          endpointId: endpoint.endpointId,
          keyId: fresh?.id ?? '',
          models: endpoint.canonicalIds.length,
        })
        Object.assign(found, added.provider)
        console.log(`[key] ${found.handle} += ${endpoint.endpointId} (${endpoint.canonicalIds.length} ids)`)
        continue
      }

      const models = mergedModels(key.allowedModels, endpoint.canonicalIds)
      const rewrites = mergedRewrites(key.modelRewrites, endpoint.rewrites)

      if (models.added.length === 0 && rewrites.added.length === 0) {
        outcomes.push({ kind: 'endpoint_unchanged', handle: found.handle, providerId: found.id, endpointId: endpoint.endpointId, keyId: key.id })
        console.log(`[same] ${found.handle} ${endpoint.endpointId}: nothing to add`)
        continue
      }

      if (!APPLY) {
        outcomes.push({
          kind: 'endpoint_extended',
          handle: found.handle,
          providerId: found.id,
          endpointId: endpoint.endpointId,
          keyId: key.id,
          modelsAdded: models.added,
          rewritesAdded: rewrites.added,
        })
        console.log(`[plan] extend ${found.handle} ${endpoint.endpointId}: +${models.added.length} models, +${rewrites.added.length} rewrites`)
        continue
      }

      const patched = await patchKey(found.id, key, models.next, rewrites.next)
      if (!patched.ok) {
        const failure = failureOf({ status: patched.status, body: patched.body })
        outcomes.push({ kind: 'failed', endpointId: endpoint.endpointId, status: patched.status, ...failure })
        console.log(`[fail] extend ${endpoint.endpointId}: ${patched.status} ${failure.code} ${failure.message}`)
        continue
      }
      outcomes.push({
        kind: 'endpoint_extended',
        handle: found.handle,
        providerId: found.id,
        endpointId: endpoint.endpointId,
        keyId: key.id,
        modelsAdded: models.added,
        rewritesAdded: rewrites.added,
      })
      console.log(`[patch] ${found.handle} ${endpoint.endpointId}: +${models.added.length} models, +${rewrites.added.length} rewrites`)
    }
  }

  let verification: VerifyResult[] = []
  if (VERIFY && APPLY) {
    verification = await verifyEndpoints(desired)
  } else if (VERIFY) {
    console.log('[verify] needs --apply: a dry run writes no providers to verify')
  }

  const finalProviders = APPLY ? await listProviders() : existing
  const report = markdownReport(manifest, desired, outcomes, verification, finalProviders)
  await mkdir(dirname(REPORT_PATH), { recursive: true })
  await writeFile(REPORT_PATH, report, 'utf8')

  const summary = {
    generatedAt: new Date().toISOString(),
    mode: APPLY ? 'apply' : 'dry-run',
    adminBase: ADMIN_BASE,
    manifest: MANIFEST_PATH,
    planned: {
      providers: desired.length,
      endpoints: desired.reduce((total, provider) => total + provider.endpoints.length, 0),
      canonicalIds: [...new Set(desired.flatMap((provider) => provider.endpoints.flatMap((endpoint) => endpoint.canonicalIds)))].sort(),
      rewrites: desired.flatMap((provider) =>
        provider.endpoints.flatMap((endpoint) =>
          Object.entries(endpoint.rewrites).map(([canonical, native]) => ({
            endpoint: endpoint.endpointId,
            canonical,
            native,
          })),
        ),
      ),
    },
    outcomes,
    verification,
  }
  await mkdir(dirname(JSON_PATH), { recursive: true })
  await writeFile(JSON_PATH, JSON.stringify(summary, null, 2), 'utf8')

  const failed = outcomes.filter((entry) => entry.kind === 'failed')
  const tally = new Map<Outcome['kind'], number>()
  for (const entry of outcomes) tally.set(entry.kind, (tally.get(entry.kind) ?? 0) + 1)

  console.log('')
  console.log(`[summary] ${[...tally].map(([kind, total]) => `${kind}=${total}`).join(' ')}`)
  console.log(`[summary] report ${REPORT_PATH}`)
  console.log(`[summary] result ${JSON_PATH}`)
  if (failed.length > 0) {
    console.log(`[summary] ${failed.length} failure(s) — see the report`)
    return 1
  }
  if (!APPLY) console.log('[summary] dry run: nothing was written. Re-run with --apply.')
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((cause: unknown) => {
    console.error(`[fatal] ${cause instanceof Error ? cause.message : String(cause)}`)
    process.exit(1)
  })