import { gzipSync } from 'node:zlib'

/**
 * Response compression for the web side. It is deliberately conservative:
 *
 *   - only `gzip`, and only when the caller asked for it;
 *   - only compressible content types, and never `text/event-stream`, so an
 *     SSE response is never buffered or delayed;
 *   - never a response that already carries a `content-encoding`;
 *   - only bodies at or above the minimum size, where the header cost and the
 *     CPU are not wasted on tiny payloads.
 *
 * The inference path keeps pass-through semantics because everything it serves
 * is either `text/event-stream` (excluded) or a provider `content-encoding`
 * (already encoded).
 */

const GZIP_ACCEPTED = /\bgzip\b/i

const COMPRESSIBLE_CONTENT_TYPE =
  /^(?:text\/(?!event-stream)|application\/(?:json|javascript|xml|x-ndjson)|image\/svg\+xml)/i

/** Below this many bytes, gzip adds more overhead than it saves. */
const MINIMUM_BYTES = 1024

/**
 * Returns a gzip-encoded copy of a Response when the request allows it and the
 * body is worth compressing. A Response that should not be compressed is
 * returned untouched, so this is safe as a blanket `mapResponse` hook.
 */
export async function compressResponse(request: Request, value: Response): Promise<Response> {
  if (request.method === 'HEAD') return value
  if (!GZIP_ACCEPTED.test(request.headers.get('accept-encoding') ?? '')) return value
  if (value.headers.has('content-encoding')) return value
  if (value.body === null) return value
  if (value.status < 200 || value.status === 204 || value.status === 205 || value.status === 304) {
    return value
  }

  const contentType = value.headers.get('content-type') ?? ''
  if (!COMPRESSIBLE_CONTENT_TYPE.test(contentType)) return value

  // Reading consumes the original body, so every path below must return a
  // rebuilt Response rather than the original.
  const bytes = new Uint8Array(await value.arrayBuffer())
  if (bytes.byteLength < MINIMUM_BYTES) {
    return rebuild(value, bytes, null)
  }

  const compressed = gzipSync(bytes)
  return rebuild(value, new Uint8Array(compressed), 'gzip')
}

function rebuild(value: Response, bytes: Uint8Array, encoding: 'gzip' | null): Response {
  const headers = new Headers(value.headers)
  headers.delete('content-length')
  if (encoding === null) {
    headers.set('content-length', String(bytes.byteLength))
  } else {
    headers.set('content-encoding', encoding)
    headers.set('content-length', String(bytes.byteLength))
    appendVary(headers, 'accept-encoding')
  }
  return new Response(bytes, {
    status: value.status,
    statusText: value.statusText,
    headers,
  })
}

function appendVary(headers: Headers, field: string): void {
  const current = headers.get('vary')
  if (current === null) {
    headers.set('vary', field)
    return
  }
  const fields = current.split(',').map((entry) => entry.trim().toLowerCase())
  if (!fields.includes(field.toLowerCase())) headers.set('vary', `${current}, ${field}`)
}