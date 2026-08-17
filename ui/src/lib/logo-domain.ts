export function normalizeLogoDomainInput(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (!trimmed.includes('://')) return normalizeHostname(trimmed)

  try {
    const url = new URL(trimmed)
    if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
      return null
    }
    return normalizeHostname(url.hostname)
  } catch {
    return null
  }
}

export function logoDomainFromBaseUrl(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (!['http:', 'https:'].includes(url.protocol)) return null
    return normalizeHostname(url.hostname)
  } catch {
    return null
  }
}

function normalizeHostname(value: string): string | null {
  const candidate = value.trim().toLowerCase().replace(/\.$/, '')
  if (candidate.length === 0 || candidate.length > 253) return null
  if (candidate.includes('://') || candidate.includes('/') || candidate.includes('@') || candidate.includes(':')) return null

  let hostname: string
  try {
    hostname = new URL(`http://${candidate}`).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return null
  }
  if (hostname !== candidate || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) return null
  const labels = hostname.split('.')
  if (labels.length < 2) return null
  if (labels.some((label) => label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null
  return hostname
}
