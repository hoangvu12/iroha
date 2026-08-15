import { describe, expect, test } from 'bun:test'
import {
  parseBulkKeyInput,
  parseBulkKeyJson,
  type ParseBulkResult,
} from './parse-bulk-keys.ts'

describe('parseBulkKeyInput', () => {
  test('empty string returns no entries', () => {
    const result = parseBulkKeyInput('')
    expect(result).toEqual({
      ok: true,
      entries: [],
      skippedHeader: false,
      comments: 0,
    })
  })

  test('only blank lines returns no entries', () => {
    const result = parseBulkKeyInput('\n\n   \n\t\n')
    expect(result).toEqual({
      ok: true,
      entries: [],
      skippedHeader: false,
      comments: 0,
    })
  })

  test('only comment lines returns no entries and counts them', () => {
    const result = parseBulkKeyInput('# one\n# two\n# three')
    expect(result).toEqual({
      ok: true,
      entries: [],
      skippedHeader: false,
      comments: 3,
    })
  })

  test('mixed blanks and comments', () => {
    const result = parseBulkKeyInput('\n# heading\n\n# note\n   \n')
    expect(result).toEqual({
      ok: true,
      entries: [],
      skippedHeader: false,
      comments: 2,
    })
  })

  test('comment with leading whitespace still counts as comment', () => {
    const result = parseBulkKeyInput('  # indented heading\nsk-1')
    expect(result).toEqual({
      ok: true,
      entries: [{ upstreamKey: 'sk-1' }],
      skippedHeader: false,
      comments: 1,
    })
  })

  test('single key with no separator', () => {
    const result = parseBulkKeyInput('sk-only')
    expect(result).toEqual({
      ok: true,
      entries: [{ upstreamKey: 'sk-only' }],
      skippedHeader: false,
      comments: 0,
    })
  })

  test('single CSV pair with key and baseUrl', () => {
    const result = parseBulkKeyInput('sk-key,https://api.example.com/v1')
    expect(result).toEqual({
      ok: true,
      entries: [{ upstreamKey: 'sk-key', baseUrl: 'https://api.example.com/v1' }],
      skippedHeader: false,
      comments: 0,
    })
  })

  test('single pipe pair with key and baseUrl', () => {
    const result = parseBulkKeyInput('sk-key|https://api.example.com/v1')
    expect(result).toEqual({
      ok: true,
      entries: [{ upstreamKey: 'sk-key', baseUrl: 'https://api.example.com/v1' }],
      skippedHeader: false,
      comments: 0,
    })
  })

  test('CSV line with trailing comma omits baseUrl', () => {
    const result = parseBulkKeyInput('sk-key,')
    expect(result).toEqual({
      ok: true,
      entries: [{ upstreamKey: 'sk-key' }],
      skippedHeader: false,
      comments: 0,
    })
  })

  test('pipe line with trailing separator omits baseUrl', () => {
    const result = parseBulkKeyInput('sk-key|')
    expect(result).toEqual({
      ok: true,
      entries: [{ upstreamKey: 'sk-key' }],
      skippedHeader: false,
      comments: 0,
    })
  })

  test('whitespace around fields is trimmed', () => {
    const result = parseBulkKeyInput('  sk-key  ,  https://api.example.com  ')
    expect(result).toEqual({
      ok: true,
      entries: [{ upstreamKey: 'sk-key', baseUrl: 'https://api.example.com' }],
      skippedHeader: false,
      comments: 0,
    })
  })

  test('header row "key,baseUrl" is skipped', () => {
    const result = parseBulkKeyInput(
      'key,baseUrl\nsk-1,https://a.example.com\nsk-2|https://b.example.com',
    )
    expect(result).toEqual({
      ok: true,
      entries: [
        { upstreamKey: 'sk-1', baseUrl: 'https://a.example.com' },
        { upstreamKey: 'sk-2', baseUrl: 'https://b.example.com' },
      ],
      skippedHeader: true,
      comments: 0,
    })
  })

  test('header row "upstreamKey,baseUrl" is skipped', () => {
    const result = parseBulkKeyInput('upstreamKey,baseUrl\nsk-1,https://a.example.com')
    expect(result).toEqual({
      ok: true,
      entries: [{ upstreamKey: 'sk-1', baseUrl: 'https://a.example.com' }],
      skippedHeader: true,
      comments: 0,
    })
  })

  test('header row is recognised case-insensitively', () => {
    const result = parseBulkKeyInput('KEY,BaseUrl\nsk-1,https://a.example.com')
    expect(result).toEqual({
      ok: true,
      entries: [{ upstreamKey: 'sk-1', baseUrl: 'https://a.example.com' }],
      skippedHeader: true,
      comments: 0,
    })
  })

  test('header row with extra leading/trailing whitespace is skipped', () => {
    const result = parseBulkKeyInput('   KEY,BASEURL   \nsk-1,https://a.example.com')
    expect(result).toEqual({
      ok: true,
      entries: [{ upstreamKey: 'sk-1', baseUrl: 'https://a.example.com' }],
      skippedHeader: true,
      comments: 0,
    })
  })

  test('header row preceded by blanks and comments is still detected', () => {
    const result = parseBulkKeyInput('\n# team A\nkey,baseUrl\nsk-1,https://a.example.com')
    expect(result).toEqual({
      ok: true,
      entries: [{ upstreamKey: 'sk-1', baseUrl: 'https://a.example.com' }],
      skippedHeader: true,
      comments: 1,
    })
  })

  test('mixed CSV and pipe lines are auto-detected per line', () => {
    const result = parseBulkKeyInput(
      'sk-1,https://a.example.com\nsk-2|https://b.example.com\nsk-3\nsk-4,https://d.example.com',
    )
    expect(result).toEqual({
      ok: true,
      entries: [
        { upstreamKey: 'sk-1', baseUrl: 'https://a.example.com' },
        { upstreamKey: 'sk-2', baseUrl: 'https://b.example.com' },
        { upstreamKey: 'sk-3' },
        { upstreamKey: 'sk-4', baseUrl: 'https://d.example.com' },
      ],
      skippedHeader: false,
      comments: 0,
    })
  })

  test('comma inside a CSV baseUrl is preserved', () => {
    const result = parseBulkKeyInput('sk-key,https://api.example.com,foo/bar')
    expect(result).toEqual({
      ok: true,
      entries: [{ upstreamKey: 'sk-key', baseUrl: 'https://api.example.com,foo/bar' }],
      skippedHeader: false,
      comments: 0,
    })
  })

  test('a pipe character on a line flips the line to pipe format regardless of CSV intent', () => {
    const result = parseBulkKeyInput('sk-key,https://api.example.com|extra')
    expect(result).toEqual({
      ok: true,
      entries: [
        { upstreamKey: 'sk-key,https://api.example.com', baseUrl: 'extra' },
      ],
      skippedHeader: false,
      comments: 0,
    })
  })

  test('pipe line preserves a comma in the baseUrl after the first pipe', () => {
    const result = parseBulkKeyInput('sk-key|https://api.example.com,foo/bar')
    expect(result).toEqual({
      ok: true,
      entries: [{ upstreamKey: 'sk-key', baseUrl: 'https://api.example.com,foo/bar' }],
      skippedHeader: false,
      comments: 0,
    })
  })

  test('comment line in the middle of data does not affect later entries', () => {
    const result = parseBulkKeyInput(
      'sk-1,https://a.example.com\n# mid comment\nsk-2|https://b.example.com',
    )
    expect(result).toEqual({
      ok: true,
      entries: [
        { upstreamKey: 'sk-1', baseUrl: 'https://a.example.com' },
        { upstreamKey: 'sk-2', baseUrl: 'https://b.example.com' },
      ],
      skippedHeader: false,
      comments: 1,
    })
  })

  test('header is only detected on the first non-blank non-comment line', () => {
    const result = parseBulkKeyInput('sk-1\nkey,baseUrl')
    expect(result).toEqual({
      ok: true,
      entries: [
        { upstreamKey: 'sk-1' },
        { upstreamKey: 'key', baseUrl: 'baseUrl' },
      ],
      skippedHeader: false,
      comments: 0,
    })
  })

  test('blank lines are silently skipped', () => {
    const result = parseBulkKeyInput('sk-1,https://a\n\nsk-2,https://b')
    expect(result).toEqual({
      ok: true,
      entries: [
        { upstreamKey: 'sk-1', baseUrl: 'https://a' },
        { upstreamKey: 'sk-2', baseUrl: 'https://b' },
      ],
      skippedHeader: false,
      comments: 0,
    })
  })

  test('a line with only whitespace is silently skipped', () => {
    const result = parseBulkKeyInput('   \nsk-1\n\t')
    expect(result).toEqual({
      ok: true,
      entries: [{ upstreamKey: 'sk-1' }],
      skippedHeader: false,
      comments: 0,
    })
  })

  test('a line whose upstream key is blank after trim is omitted', () => {
    const result = parseBulkKeyInput(',https://a.example.com')
    expect(result).toEqual({
      ok: true,
      entries: [],
      skippedHeader: false,
      comments: 0,
    })
  })

  test('handles Windows line endings', () => {
    const result = parseBulkKeyInput('sk-1,https://a\r\nsk-2,https://b\r\n')
    expect(result).toEqual({
      ok: true,
      entries: [
        { upstreamKey: 'sk-1', baseUrl: 'https://a' },
        { upstreamKey: 'sk-2', baseUrl: 'https://b' },
      ],
      skippedHeader: false,
      comments: 0,
    })
  })
})

describe('parseBulkKeyJson', () => {
  test('maps Nyanis key and url aliases to the canonical fields', () => {
    const result = parseBulkKeyJson(
      '[{"candidateId":3833,"key":"sk-nyanis","provider":"dashscope","status":"working","url":"https://dashscope-intl.aliyuncs.com/compatible-mode/v1"}]',
    )
    expect(result).toEqual({
      ok: true,
      entries: [
        {
          upstreamKey: 'sk-nyanis',
          baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        },
      ],
      skippedHeader: false,
      comments: 0,
    })
  })

  test('parses a valid JSON array of entries', () => {
    const result = parseBulkKeyJson(
      '[{"upstreamKey":"sk-1"},{"upstreamKey":"sk-2","baseUrl":"https://b.example.com"}]',
    )
    expect(result).toEqual({
      ok: true,
      entries: [
        { upstreamKey: 'sk-1' },
        { upstreamKey: 'sk-2', baseUrl: 'https://b.example.com' },
      ],
      skippedHeader: false,
      comments: 0,
    })
  })

  test('parses an empty array', () => {
    const result = parseBulkKeyJson('[]')
    expect(result).toEqual({
      ok: true,
      entries: [],
      skippedHeader: false,
      comments: 0,
    })
  })

  test('returns malformed_json for unparseable text', () => {
    const result = parseBulkKeyJson('not json')
    expect(result.ok).toBe(false)
    assertMalformedJson(result)
  })

  test('returns malformed_json when the JSON is not an array', () => {
    const result = parseBulkKeyJson('{"upstreamKey":"sk-1"}')
    expect(result.ok).toBe(false)
    assertMalformedJson(result)
  })

  test('returns malformed_json when the JSON is a primitive', () => {
    const result = parseBulkKeyJson('null')
    expect(result.ok).toBe(false)
    assertMalformedJson(result)
  })

  test('returns malformed_json when an array entry is not an object', () => {
    const result = parseBulkKeyJson('[{"upstreamKey":"sk-1"},"not-an-object"]')
    expect(result.ok).toBe(false)
    assertMalformedJson(result)
  })

  test('returns malformed_json when an array entry is null', () => {
    const result = parseBulkKeyJson('[null]')
    expect(result.ok).toBe(false)
    assertMalformedJson(result)
  })

  test('returns malformed_json when an entry has no upstreamKey', () => {
    const result = parseBulkKeyJson('[{"baseUrl":"https://a.example.com"}]')
    expect(result.ok).toBe(false)
    assertMalformedJson(result)
  })

  test('returns malformed_json when an entry has a non-string baseUrl', () => {
    const result = parseBulkKeyJson('[{"upstreamKey":"sk-1","baseUrl":42}]')
    expect(result.ok).toBe(false)
    assertMalformedJson(result)
  })
})

function assertMalformedJson(result: ParseBulkResult): asserts result is {
  ok: false
  reason: 'malformed_json'
  message: string
} {
  if (result.ok !== false) {
    throw new Error('expected ok: false')
  }
  expect(result.reason).toBe('malformed_json')
  expect(typeof result.message).toBe('string')
  expect(result.message.length).toBeGreaterThan(0)
}
