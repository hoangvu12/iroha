/** Reads a bearer credential from a Fetch API header collection. */
export function bearerToken(headers: Headers): string | null {
  const value = headers.get('authorization')
  if (value === null) return null

  const match = /^Bearer (.+)$/i.exec(value.trim())
  return match === null ? null : match[1]!.trim()
}
