/**
 * Value-free descriptions of configuration input.
 *
 * Configuration errors and startup logs are read by whoever operates the
 * installation, which may include a hosting provider's log pipeline. Nothing in
 * this module may return a secret value: not a master key, not a setup or
 * recovery token, and not the password embedded in a PostgreSQL URL.
 */

const SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):/

/**
 * The scheme of a URL-shaped value, or `null` when the value has no scheme.
 *
 * A scheme is safe to echo back to the Owner; the rest of the value is not.
 * Returning `null` for an unparseable value keeps a mistyped secret out of the
 * error message it would otherwise land in.
 */
export function schemeOf(value: string): string | null {
  return SCHEME_PATTERN.exec(value.trim())?.[1] ?? null
}

/**
 * A PostgreSQL URL with its password removed, for display in logs and health
 * output. Returns a generic description when the URL cannot be parsed, because
 * an unparseable URL cannot be reliably stripped.
 */
export function redactPostgresUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'postgresql (unparseable URL)'
  }

  parsed.password = ''
  parsed.search = ''
  return parsed.toString()
}
