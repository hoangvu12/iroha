import { randomUUID } from 'node:crypto'
import type {
  InferenceAdapter,
  InferenceAdapterCapabilities,
  InferenceForwardRequest,
  InferenceForwardResult,
} from './adapter.ts'

export interface GenericInferenceAdapterOptions {
  /** Injectable transport; production uses the runtime's fetch. */
  readonly fetch?: typeof fetch
}

/** The generic adapter declares Idempotency-Key with safe generation. */
const GENERIC_CAPABILITIES: InferenceAdapterCapabilities = {
  idempotencyHeader: 'Idempotency-Key',
  idempotencyGenerationSafe: true,
}

/**
 * Hop-by-hop headers (RFC 9113 §8.2.2 and friends), proxy-control headers,
 * credential-bearing headers, and headers Iroha itself owns are never
 * forwarded upstream. Everything else passes through so provider extensions
 * keep working.
 */
const BLOCKED_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'proxy-authenticate',
  'proxy-authorization',
  'referer',
  'set-cookie',
  'te',
  'traceparent',
  'tracestate',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
  'x-correlation-id',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'x-request-id',
])

/**
 * The generic OpenAI-compatible Inference Adapter: endpoint construction from
 * the connection's base URL, safe bearer authentication, conservative redirect
 * behaviour, and unchanged request and response bodies. No executable
 * authentication code is ever accepted through configuration.
 *
 * `redirect: 'manual'` is the default. When the Owner explicitly enables
 * same-origin redirects on a connection, the wrapper follows them, but only
 * as long as the resolved URL stays on the originally configured origin; any
 * cross-origin hop is refused by returning the redirect response itself so
 * the routing layer can map it to `upstream_redirect`. The upstream key, the
 * static headers, and the configured authentication header therefore never
 * reach a different origin: the request is never issued.
 */
export function createGenericInferenceAdapter(
  options: GenericInferenceAdapterOptions = {},
): InferenceAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch

  return {
    capabilities: GENERIC_CAPABILITIES,

    async forward(request: InferenceForwardRequest): Promise<InferenceForwardResult> {
      const forwarded: Record<string, string> = {}
      for (const [name, value] of Object.entries(request.headers)) {
        if (!BLOCKED_HEADERS.has(name.toLowerCase())) forwarded[name] = value
      }
      // The configured authentication header always wins over any caller-supplied
      // value: the prefix and key together form one atomic value the Owner
      // chose, and an existing header in the same slot is overwritten rather
      // than appended so a caller cannot smuggle a second credential.
      forwarded[request.authHeader.toLowerCase()] = `${request.authPrefix}${request.upstreamKey}`
      forwarded['content-type'] ??= 'application/json'
      if (!('accept' in forwarded)) forwarded['accept'] = 'application/json'
      mergeStaticHeaders(forwarded, request.staticHeaders, request.authHeader)

      const upstreamHeaders = { ...forwarded }
      const signal = request.signal ?? null

      const follow = request.redirectAllowSameOrigin ? 'follow-same-origin' : 'manual'
      const response = await fetchWithSameOriginRedirects(fetchImpl, {
        url: upstreamUrl(request.baseUrl, request.path),
        method: request.method,
        headers: upstreamHeaders,
        body: request.body ?? undefined,
        signal,
        follow,
        origin: sameOriginOf(request.baseUrl),
      })

      if (request.stream === true) {
        return {
          kind: 'stream',
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          stream: response.body ?? new ReadableStream<Uint8Array>(),
        }
      }

      return {
        kind: 'buffered',
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.text(),
      }
    },
  }
}

/** Joins a base URL and a provider path once, tolerating a trailing slash. */
export function upstreamUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

/**
 * Merges the connection's static headers without overwriting the
 * authentication header that was just installed.
 */
function mergeStaticHeaders(
  forwarded: Record<string, string>,
  staticHeaders: Readonly<Record<string, string>>,
  authHeader: string,
): void {
  for (const [name, value] of Object.entries(staticHeaders)) {
    if (name.toLowerCase() === authHeader.toLowerCase()) continue
    forwarded[name.toLowerCase()] = value
  }
}

/**
 * A manually-redirected fetch the same-origin path walks. The transport is
 * `redirect: 'manual'` on every call; the wrapper inspects each response and,
 * when the Owner enabled same-origin redirects, follows it as long as the
 * `Location` stays on the configured origin. A cross-origin hop returns the
 * redirect response itself so the routing layer can map it to `upstream_redirect`.
 */
async function fetchWithSameOriginRedirects(
  fetchImpl: typeof fetch,
  options: {
    url: string
    method: InferenceForwardRequest['method']
    headers: Readonly<Record<string, string>>
    body: string | undefined
    signal: AbortSignal | null
    follow: 'manual' | 'follow-same-origin'
    origin: string | null
  },
): Promise<Response> {
  let currentUrl = options.url
  let currentHeaders: Record<string, string> = { ...options.headers }

  while (true) {
    const response = await fetchImpl(currentUrl, {
      method: options.method,
      headers: currentHeaders,
      body: options.body,
      redirect: 'manual',
      signal: options.signal,
    })

    if (response.status < 300 || response.status >= 400) return response
    if (options.follow !== 'follow-same-origin') return response
    if (options.origin === null) return response

    const location = response.headers.get('location')
    if (location === null) return response
    void response.body?.cancel().catch(() => undefined)

    const nextUrl = new URL(location, currentUrl).href
    if (!sameOrigin(nextUrl, options.origin)) return response

    // Credentials and static headers stay in place because the resolved URL
    // remains on the configured origin. Iroha never propagates them across a
    // host change; this branch is exactly the "same-origin only" path.
    currentUrl = nextUrl
  }
}

/** The `{scheme}://{host}:{port}` portion of a base URL, or null when invalid. */
function sameOriginOf(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return null
  }
}

/** Two URLs share an origin when their scheme, host, and port match. */
function sameOrigin(url: string, origin: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return `${parsed.protocol}//${parsed.host}` === origin
}

/**
 * Looks at the caller's headers and reports whether the request already carries
 * an idempotency value. The header name lookup is case-insensitive so a caller
 * writing `Idempotency-Key` or `idempotency-key` is the same Iroha read.
 */
export function callerSuppliedIdempotency(
  headers: Readonly<Record<string, string>>,
  headerName: string,
): string | null {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === headerName.toLowerCase()) return value
  }
  return null
}

/** A fresh RFC-4122 v4 UUID, exported for callers that need the same shape. */
export function generateIdempotencyValue(): string {
  return randomUUID()
}
