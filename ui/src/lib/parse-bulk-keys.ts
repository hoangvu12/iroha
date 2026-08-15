export type BulkKeyEntry = {
  upstreamKey: string
  baseUrl?: string
}

export type ParseBulkResult =
  | {
      ok: true
      entries: BulkKeyEntry[]
      skippedHeader: boolean
      comments: number
    }
  | { ok: false; reason: 'malformed_json'; message: string }

const HEADER_SPELLINGS = new Set(['key,baseurl', 'upstreamkey,baseurl'])

export function parseBulkKeyInput(text: string): ParseBulkResult {
  const lines = text.split(/\r?\n/)
  const entries: BulkKeyEntry[] = []
  let skippedHeader = false
  let comments = 0
  let headerCheckPending = true

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()

    if (trimmed === '') continue

    if (trimmed.startsWith('#')) {
      comments += 1
      continue
    }

    if (headerCheckPending) {
      headerCheckPending = false
      if (HEADER_SPELLINGS.has(trimmed.toLowerCase())) {
        skippedHeader = true
        continue
      }
    }

    const entry = parseDataLine(rawLine)
    if (entry !== null) entries.push(entry)
  }

  return { ok: true, entries, skippedHeader, comments }
}

function parseDataLine(rawLine: string): BulkKeyEntry | null {
  const pipeIdx = rawLine.indexOf('|')
  if (pipeIdx !== -1) {
    const upstreamKey = rawLine.slice(0, pipeIdx).trim()
    const baseUrl = rawLine.slice(pipeIdx + 1).trim()
    if (upstreamKey === '') return null
    if (baseUrl === '') return { upstreamKey }
    return { upstreamKey, baseUrl }
  }

  const commaIdx = rawLine.indexOf(',')
  if (commaIdx !== -1) {
    const upstreamKey = rawLine.slice(0, commaIdx).trim()
    const baseUrl = rawLine.slice(commaIdx + 1).trim()
    if (upstreamKey === '') return null
    if (baseUrl === '') return { upstreamKey }
    return { upstreamKey, baseUrl }
  }

  const upstreamKey = rawLine.trim()
  if (upstreamKey === '') return null
  return { upstreamKey }
}

export function parseBulkKeyJson(text: string): ParseBulkResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return {
      ok: false,
      reason: 'malformed_json',
      message: err instanceof Error ? err.message : String(err),
    }
  }

  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      reason: 'malformed_json',
      message: 'Expected a JSON array of entries',
    }
  }

  const entries: BulkKeyEntry[] = []
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return {
        ok: false,
        reason: 'malformed_json',
        message: 'Each entry must be an object with upstreamKey and optional baseUrl',
      }
    }
    const candidate = item as {
      upstreamKey?: unknown
      key?: unknown
      baseUrl?: unknown
      url?: unknown
    }
    const upstreamKey = candidate.upstreamKey ?? candidate.key
    const baseUrl = candidate.baseUrl ?? candidate.url
    if (typeof upstreamKey !== 'string' || upstreamKey === '') {
      return {
        ok: false,
        reason: 'malformed_json',
        message: 'Each entry must have a non-empty string upstreamKey or key',
      }
    }
    const entry: BulkKeyEntry = { upstreamKey }
    if (baseUrl !== undefined && baseUrl !== null) {
      if (typeof baseUrl !== 'string') {
        return {
          ok: false,
          reason: 'malformed_json',
          message: 'Entry baseUrl or url must be a string when present',
        }
      }
      if (baseUrl !== '') entry.baseUrl = baseUrl
    }
    entries.push(entry)
  }

  return { ok: true, entries, skippedHeader: false, comments: 0 }
}
