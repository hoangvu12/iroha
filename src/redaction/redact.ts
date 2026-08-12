/**
 * Secret-aware redaction.
 *
 * Anything Iroha writes to a log, an error response, or an audit row may have
 * passed through upstream or may have been built from caller input. Iroha
 * must scrub anything that looks like a credential before it lands in a
 * place a human reads, because a misconfigured retry path or a confused
 * upstream message body is how secrets normally leak.
 *
 * The strategy is conservative: redact anything that resembles an HTTP
 * `Authorization` header value, an API key in a known Providers' shape, or a
 * JSON field whose name is on the deny-list. The intent is that a tester
 * seeding a known bad value will find no trace of it in the response, the
 * audit detail, or the persisted history.
 */

const REDACTED = '[REDACTED]'

/** The header names whose value must never travel past the inference boundary. */
const CREDENTIAL_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
])

/** The OpenAI / Provider API key shape `sk-` followed by enough entropy. */
const SK_PATTERN = /\bsk-[A-Za-z0-9_\-]{16,}\b/g

/** Bearer-style credentials, including the new line. The `Bearer` label is preserved so a log keeps the credential type. */
const BEARER_PATTERN = /(Bearer)(\s+)([A-Za-z0-9._\-+/=]{8,})/gi

/** A `key=value` or `key: value` pair carrying an obvious secret. */
const KEY_VALUE_SECRET = /(?:api[-_]?key|access[-_]?token|secret|password|token)\s*[:=]\s*['"]?([^\s'",;}{]+)/gi

/**
 * The JSON keys whose value must never survive a round-trip through a
 * diagnostic. The match is case-insensitive and matches the whole key, so a
 * field literally called `secret_hint` is redacted too.
 */
const SENSITIVE_JSON_KEYS = new Set([
  'apikey',
  'api_key',
  'authorization',
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'upstreamkey',
  'upstream_key',
  'gatewaykey',
  'gateway_key',
  'x-api-key',
])

/** A wrapper around a set of values the caller knows are secret. */
export class SecretValues {
  readonly #values: readonly string[]

  constructor(values: readonly string[]) {
    this.#values = values.filter((value) => value.length >= 4)
  }

  static empty(): SecretValues {
    return new SecretValues([])
  }

  static of(...values: readonly string[]): SecretValues {
    return new SecretValues(values)
  }

  /** Redacts every known secret from `text`, returning the safe equivalent. */
  scrub(text: string): string {
    if (this.#values.length === 0) return text
    let result = text
    for (const value of this.#values) {
      if (value.length === 0) continue
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      result = result.replace(new RegExp(escaped, 'g'), REDACTED)
    }
    return result
  }
}

/**
 * The default scrubber: walks text, header maps, and JSON-like objects and
 * replaces anything that looks like a secret. The shape of the input is the
 * shape of the output, so an audit row can `redact(row.detail)` and keep
 * the rest of the detail readable.
 */
export function redact(value: unknown, secrets: SecretValues = SecretValues.empty()): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return scrubString(value, secrets)
  if (Array.isArray(value)) return value.map((entry) => redact(entry, secrets))
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        result[key] = REDACTED
        continue
      }
      result[key] = redact(entry, secrets)
    }
    return result
  }
  return value
}

/**
 * Redacts a request header map. The header name tells us whether the value
 * is a credential; the value itself is also scrubbed in case an upstream
 * echoed a secret in a non-credential header.
 */
export function redactHeaders(
  headers: Readonly<Record<string, string>>,
  secrets: SecretValues = SecretValues.empty(),
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (CREDENTIAL_HEADER_NAMES.has(name.toLowerCase())) {
      result[name] = REDACTED
      continue
    }
    result[name] = scrubString(value, secrets)
  }
  return result
}

function scrubString(text: string, secrets: SecretValues): string {
  let result = secrets.scrub(text)
  result = result.replace(SK_PATTERN, REDACTED)
  result = result.replace(BEARER_PATTERN, (_match, scheme: string, gap: string) => `${scheme}${gap}${REDACTED}`)
  result = result.replace(KEY_VALUE_SECRET, (_match, captured: string) => {
    return `${_match.slice(0, _match.length - captured.length)}${REDACTED}`
  })
  return result
}

function isSensitiveKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[^a-z0-9_-]/g, '')
  return SENSITIVE_JSON_KEYS.has(normalised)
}

/** A constant marker used to assert redacted output in tests. */
export const REDACTION_MARKER = REDACTED