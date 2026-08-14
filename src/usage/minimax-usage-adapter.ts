import type {
  UsageAdapter,
  UsageAdapterRequest,
  UsagePollResult,
  UsageReading,
} from './adapter.ts'

/**
 * The MiniMax Usage Adapter: reads the Owner-facing entitlement for a
 * MiniMax Provider by chaining MiniMax's documented entitlement endpoints.
 *
 * The chain matches MiniMax's billing surface:
 *
 *   1. `GET {entitlementHost}/v1/api/openplatform/coding_plan/remains` —
 *      the coding-plan window per model. When the key has an active
 *      subscription this returns `model_remains[]` with current-window
 *      and weekly limits plus percent remaining and reset times.
 *
 *   2. `GET {entitlementHost}/account/query_balance` — the prepaid
 *      wallet balance, in CNY. Used as the fallback when the key has no
 *      active coding-plan subscription (`base_resp.status_code === 2062`)
 *      or when the subscription response is otherwise empty.
 *
 * The adapter is `authoritative`: the endpoints are documented MiniMax
 * APIs reachable with the same Bearer key as inference, plus a load-bearing
 * `referer` header that the upstream requires for the entitlement surface
 * even though it does not require it for chat completions.
 *
 * Region routing is derived from the Provider's base URL hostname:
 *
 * - `*.minimax.io` → `https://api.minimax.io`, referer `https://platform.minimax.io/`
 * - `*.minimaxi.com` (or `www.minimaxi.com`) → `https://www.minimaxi.com`, referer `https://platform.minimaxi.com/`
 * - `*.minimax.chat` (or `api.minimax.chat`) → `https://api.minimax.chat`, referer `https://platform.minimax.io/`
 * - any other MiniMax-shaped host → defaults to the `.io` region.
 *
 * The adapter does not chain across unknown hosts; a base URL that points
 * somewhere unrecognised falls through to the `.io` region so a typo'd
 * Provider still gets a real entitlement read.
 */

interface MiniMaxRegion {
  readonly entitlementHost: string
  readonly referer: string
}

export interface MinimaxUsageAdapterOptions {
  /** Injectable transport; production uses the runtime's fetch. */
  readonly fetch?: typeof fetch
}

const SUBSCRIPTION_PATH = '/v1/api/openplatform/coding_plan/remains'
const CREDIT_PATH = '/account/query_balance'

function regionFor(baseUrl: string): MiniMaxRegion {
  let host: string
  try {
    host = new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return {
      entitlementHost: 'https://api.minimax.io',
      referer: 'https://platform.minimax.io/',
    }
  }
  if (host === 'www.minimaxi.com' || host.endsWith('.minimaxi.com')) {
    return {
      entitlementHost: 'https://www.minimaxi.com',
      referer: 'https://platform.minimaxi.com/',
    }
  }
  if (host === 'api.minimax.chat' || host.endsWith('.minimax.chat')) {
    return {
      entitlementHost: 'https://api.minimax.chat',
      referer: 'https://platform.minimax.io/',
    }
  }
  // Default to the .io region for any minimax-shaped host, including the
  // canonical base URL shipped in the template.
  return {
    entitlementHost: 'https://api.minimax.io',
    referer: 'https://platform.minimax.io/',
  }
}

function authHeaders(upstreamKey: string, referer: string): Record<string, string> {
  return {
    authorization: `Bearer ${upstreamKey}`,
    referer,
    accept: 'application/json',
  }
}

interface SubscriptionResponse {
  readonly model_remains?: readonly ModelRemain[] | null
  readonly base_resp?: { readonly status_code?: number; readonly status_msg?: string }
}

interface ModelRemain {
  /**
   * The MiniMax response names the plan `model_name`, not `model`. The
   * adapter reads either: a real MiniMax `model_name` (e.g. `"general"`,
   * `"video"`) is the canonical case; `model` is a defensive fallback in
   * case the upstream ever renames the field.
   */
  readonly model_name?: string
  readonly model?: string
  readonly start_time?: number
  readonly end_time?: number
  readonly current_interval_total_count?: number
  readonly current_interval_usage_count?: number
  readonly current_interval_remaining_percent?: number
  readonly remains_time?: number
  readonly current_week_total_count?: number
  readonly current_week_remaining_percent?: number
  readonly current_week_remains_time?: number
  readonly current_subscribe?: { readonly current_subscribe_end_time?: number }
}

/**
 * The MiniMax coding-plan tier the iroha gateway cares about. The
 * `/coding_plan/remains` endpoint returns one entry per plan tier the
 * account holds (e.g. `"general"` for general coding, `"video"` for
 * video-related requests). The gateway routes coding inference, so only
 * the general tier is in scope; other tiers are filtered out so the cell
 * answers "how much coding capacity is left?" with one number.
 *
 * If MiniMax renames the tier, this constant is the only place that needs
 * updating.
 */
const CODING_PLAN_TIER = 'general'

function parseSubscription(
  body: unknown,
  at: Date,
): readonly UsageReading[] {
  if (typeof body !== 'object' || body === null) return []
  const resp = body as SubscriptionResponse
  const statusCode = resp.base_resp?.status_code
  if (statusCode !== undefined && statusCode !== 0) {
    // 2062 (no active token-plan subscription) and any other non-zero code
    // means the caller should fall through to the credit endpoint.
    return []
  }
  const remains = resp.model_remains
  if (!Array.isArray(remains) || remains.length === 0) return []

  const out: UsageReading[] = []
  for (const entry of remains) {
    if (entry === null || typeof entry !== 'object') continue

    const tier = readModelName(entry)
    if (tier !== CODING_PLAN_TIER) continue

    const remainingPercent = entry.current_interval_remaining_percent
    if (typeof remainingPercent !== 'number') continue

    const resetAt =
      typeof entry.end_time === 'number' && entry.end_time > 0
        ? new Date(entry.end_time)
        : typeof entry.remains_time === 'number' && entry.remains_time > 0
          ? new Date(at.getTime() + entry.remains_time)
          : null

    out.push({
      unit: 'requests',
      balance: null,
      used: null,
      limit: null,
      remainingPercent,
      plan: tier,
      resetAt,
      scope: { kind: 'connection_model', model: tier },
      confidence: 'confirmed',
      diagnostics: {
        source: 'minimax-usage-adapter',
        kind: 'subscription',
      },
    })
  }
  return out
}

/**
 * The MiniMax response names the plan `model_name` (e.g. `"general"`,
 * `"video"`). The earlier `model` field is kept as a defensive fallback in
 * case the upstream renames the field again.
 */
function readModelName(entry: ModelRemain): string | null {
  if (typeof entry.model_name === 'string' && entry.model_name !== '') return entry.model_name
  if (typeof entry.model === 'string' && entry.model !== '') return entry.model
  return null
}

interface CreditResponse {
  readonly available_amount?: string
  readonly base_resp?: { readonly status_code?: number; readonly status_msg?: string }
}

function parseCredit(body: unknown): readonly UsageReading[] {
  if (typeof body !== 'object' || body === null) return []
  const resp = body as CreditResponse
  const statusCode = resp.base_resp?.status_code
  if (statusCode !== undefined && statusCode !== 0) return []
  if (typeof resp.available_amount !== 'string') return []
  const balance = Number.parseFloat(resp.available_amount)
  if (!Number.isFinite(balance)) return []

  return [
    {
      unit: 'cny',
      balance,
      used: null,
      limit: null,
      remainingPercent: null,
      plan: null,
      resetAt: null,
      scope: { kind: 'provider' },
      confidence: 'confirmed',
      diagnostics: {
        source: 'minimax-usage-adapter',
        kind: 'credit',
      },
    },
  ]
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal | null | undefined,
): Promise<
  | { ok: true; body: unknown }
  | { ok: false; status: number | null; parseError: boolean }
> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      ...(signal === null || signal === undefined ? {} : { signal }),
    })
  } catch {
    return { ok: false, status: null, parseError: false }
  }
  if (response.status >= 300 && response.status < 400) {
    // MiniMax entitlement redirects must not be followed silently — the
    // load-bearing referer is region-scoped and a redirect could carry the
    // key to a host whose entitlement surface is gated differently.
    void response.body?.cancel().catch(() => undefined)
    return { ok: false, status: response.status, parseError: false }
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined)
    return { ok: false, status: response.status, parseError: false }
  }
  try {
    const body = (await response.json()) as unknown
    return { ok: true, body }
  } catch {
    void response.body?.cancel().catch(() => undefined)
    return { ok: false, status: response.status, parseError: true }
  }
}

export function createMinimaxUsageAdapter(
  options: MinimaxUsageAdapterOptions = {},
): UsageAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch

  return {
    visibility: 'authoritative',
    async read(request: UsageAdapterRequest): Promise<UsagePollResult> {
      if (request.signal?.aborted === true) {
        return {
          ok: false,
          failure: { code: 'upstream_unreachable', message: 'the poll was cancelled' },
        }
      }
      const region = regionFor(request.baseUrl)
      const headers = authHeaders(request.upstreamKey, region.referer)

      const subscriptionUrl = `${region.entitlementHost}${SUBSCRIPTION_PATH}`
      const subscription = await fetchJson(
        fetchImpl,
        subscriptionUrl,
        headers,
        request.signal ?? null,
      )

      if (subscription.ok) {
        const readings = parseSubscription(subscription.body, new Date())
        if (readings.length > 0) return { ok: true, readings }
      } else if (subscription.status !== null && subscription.status >= 400 && subscription.status < 500) {
        // 4xx on the subscription endpoint is the upstream telling us the
        // caller cannot use it; fall through to credit rather than report
        // an unreachable entitlement.
      } else if (subscription.status === null) {
        return {
          ok: false,
          failure: {
            code: 'upstream_unreachable',
            message: 'MiniMax subscription endpoint could not be reached',
          },
        }
      }

      const creditUrl = `${region.entitlementHost}${CREDIT_PATH}`
      const credit = await fetchJson(fetchImpl, creditUrl, headers, request.signal ?? null)
      if (!credit.ok) {
        if (credit.status === null) {
          return {
            ok: false,
            failure: {
              code: 'upstream_unreachable',
              message: 'MiniMax credit endpoint could not be reached',
            },
          }
        }
        if (credit.parseError) {
          return {
            ok: false,
            failure: {
              code: 'unparseable_response',
              message: `MiniMax credit endpoint returned HTTP ${credit.status} with an unparseable body`,
            },
          }
        }
        return {
          ok: false,
          failure: {
            code: 'upstream_refused',
            status: credit.status,
            message: `MiniMax credit endpoint refused (HTTP ${credit.status})`,
          },
        }
      }
      const readings = parseCredit(credit.body)
      if (readings.length === 0) {
        return {
          ok: false,
          failure: {
            code: 'unparseable_response',
            message: 'MiniMax credit response did not match the expected shape',
          },
        }
      }
      return { ok: true, readings }
    },
  }
}