/**
 * The bounded, Provider-agnostic facts Iroha may read out of a failed upstream
 * body: the Provider's error code and type, the Provider's own request id, and
 * the request field a strict validator rejected.
 *
 * Everything here is structural. Free text — messages, descriptions, bodies,
 * validation prose — never leaves this module, because an upstream message may
 * echo a credential or content the Owner never asked Iroha to retain.
 *
 * One extractor serves both readers: the Inference Adapter, which turns it into
 * Attempt diagnostics, and the routing layer, which turns it into the failure
 * log line. Sharing it keeps the two from drifting apart.
 */

export interface SafeUpstreamErrorFields {
  readonly code: string | null
  readonly type: string | null
  readonly requestId: string | null
  /** The request field a Provider rejected, when its envelope names one. */
  readonly field: string | null
}

const EMPTY: SafeUpstreamErrorFields = { code: null, type: null, requestId: null, field: null }

const CODE_LIMIT = 80
const TYPE_LIMIT = 80
const FIELD_LIMIT = 64
const REQUEST_ID_LIMIT = 120

export function safeUpstreamErrorFields(body: string): SafeUpstreamErrorFields {
  let root: unknown
  try { root = JSON.parse(body) } catch { return EMPTY }
  if (!isRecord(root)) return EMPTY
  const error = isRecord(root.error) ? root.error : undefined
  // Some Providers wrap the envelope in `error` (OpenAI, DashScope, Z.ai) and
  // some answer it at the root (Mistral). Reading the error object first and
  // the root second covers both without guessing.
  const nested = error ?? root
  return {
    code: safeDiagnosticField(nested.code, CODE_LIMIT),
    type: safeDiagnosticField(nested.type, TYPE_LIMIT),
    requestId: safeDiagnosticField(root.request_id ?? root.requestId, REQUEST_ID_LIMIT),
    field: rejectedField(nested),
  }
}

/**
 * Reads the field a Provider refused from the two shapes that name one:
 * OpenAI-style `error.param`, and the Pydantic-style `error.detail[].loc` path
 * that Mistral nests under `error.message`. A body matching neither yields no
 * field rather than a guess.
 */
function rejectedField(nested: Readonly<Record<string, unknown>>): string | null {
  const param = safeDiagnosticField(nested.param, FIELD_LIMIT)
  if (param !== null) return param
  const message = isRecord(nested.message) ? nested.message : undefined
  for (const detail of [nested.detail, message?.detail]) {
    const path = locationPath(detail)
    if (path !== null) return path
  }
  return null
}

function locationPath(detail: unknown): string | null {
  if (!Array.isArray(detail)) return null
  for (const entry of detail) {
    if (!isRecord(entry)) continue
    const loc = entry.loc
    if (!Array.isArray(loc)) continue
    const parts = loc
      .filter((part) => typeof part === 'string' || typeof part === 'number')
      .map((part) => String(part))
    // A leading `body` is the envelope segment every validator names; the rest
    // is what the caller actually sent.
    const field = (parts[0] === 'body' ? parts.slice(1) : parts).join('.')
    const safe = safeDiagnosticField(field, FIELD_LIMIT)
    if (safe !== null) return safe
  }
  return null
}

/**
 * Bounds and redacts one diagnostic value. Credential-shaped text is replaced
 * rather than truncated, so a leaked secret cannot survive as a prefix.
 */
export function safeDiagnosticField(value: unknown, limit: number): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{8,}\b/gi, '<REDACTED>')
    .replace(/Bearer\s+\S+/gi, 'Bearer <REDACTED>')
    .trim()
  return text === '' ? null : text.slice(0, limit)
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}