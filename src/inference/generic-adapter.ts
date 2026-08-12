import type { InferenceAdapter, InferenceForwardRequest, InferenceForwardResult } from './adapter.ts'

export interface GenericInferenceAdapterOptions {
  /** Injectable transport; production uses the runtime's fetch. */
  readonly fetch?: typeof fetch
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
 */
export function createGenericInferenceAdapter(
  options: GenericInferenceAdapterOptions = {},
): InferenceAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch

  return {
    async forward(request: InferenceForwardRequest): Promise<InferenceForwardResult> {
      const headers = forwardHeaders(request.headers)
      headers['authorization'] = `Bearer ${request.upstreamKey}`
      headers['content-type'] ??= 'application/json'
      if (!('accept' in headers)) headers['accept'] = 'application/json'

      const response = await fetchImpl(upstreamUrl(request.baseUrl, request.path), {
        method: request.method,
        headers,
        body: request.body ?? undefined,
        // A redirect could carry the Upstream Key to another origin; the
        // transport rules reject redirects rather than following them.
        redirect: 'manual',
        signal: request.signal ?? null,
      })

      return {
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

/** Copies only headers that are safe to forward, leaving all secrets behind. */
function forwardHeaders(
  incoming: Readonly<Record<string, string>>,
): Record<string, string> {
  const forwarded: Record<string, string> = {}
  for (const [name, value] of Object.entries(incoming)) {
    if (!BLOCKED_HEADERS.has(name.toLowerCase())) forwarded[name] = value
  }
  return forwarded
}
