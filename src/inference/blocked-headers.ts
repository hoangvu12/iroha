/**
 * Hop-by-hop headers (RFC 9113 §8.2.2 and friends), proxy-control headers,
 * credential-bearing headers, and headers Iroha itself owns are never
 * forwarded upstream. Every Inference Adapter and the inference HTTP route
 * use the same list so a caller-supplied header cannot smuggle through one
 * adapter what another blocks.
 */
export const adapterBlockedHeaders: ReadonlySet<string> = new Set([
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