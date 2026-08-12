import { describe, expect, test } from 'bun:test'
import { redact, redactHeaders, REDACTION_MARKER, SecretValues } from '../../src/redaction/index.ts'

/**
 * The systematic redaction tests the spec names: seed every secret-like value
 * through every supported path (string, object, header map, unknown value
 * shape) and prove the marker replaces it everywhere it appears.
 */

describe('redact', () => {
  test('replaces an OpenAI-shaped API key inside free text', () => {
    const out = redact('the key was sk-abcdefghijklmnop1234 in the message') as string
    expect(out).toBe(`the key was ${REDACTION_MARKER} in the message`)
  })

  test('replaces a Bearer-style credential header value', () => {
    const out = redact('Authorization: Bearer abcdefghijklmnop1234') as string
    expect(out).toBe(`Authorization: Bearer ${REDACTION_MARKER}`)
  })

  test('replaces an explicit secret key=value pair', () => {
    const out = redact('password=hunter2hunter2 and api_key=secretsecretsecret') as string
    expect(out).toContain(`${REDACTION_MARKER}`)
    expect(out).not.toContain('hunter2hunter2')
    expect(out).not.toContain('secretsecretsecret')
  })

  test('walks an object tree and redacts sensitive keys without losing structure', () => {
    const safe = redact({
      username: 'owner',
      detail: { upstreamKey: 'sk-aaaaaaaaaaaaaaaa', displayName: 'Example' },
    })
    expect(safe).toEqual({
      username: 'owner',
      detail: { upstreamKey: REDACTION_MARKER, displayName: 'Example' },
    })
  })

  test('redacts both name and value of secret-bearing object keys', () => {
    const out = redact({
      gatewayKey: { id: 'gk_one', secret: 'secretpart-of-the-credential' },
      notes: 'no secrets here',
    }) as { gatewayKey: unknown; notes: string }
    expect(out.gatewayKey).toBe(REDACTION_MARKER)
    expect(out.notes).toBe('no secrets here')
  })

  test('walks arrays and replaces secrets per element', () => {
    const out = redact(['sk-aaaaaaaaaaaaaaaa', 'plain']) as string[]
    expect(out).toEqual([REDACTION_MARKER, 'plain'])
  })

  test('returns null, undefined, and primitives unchanged in shape', () => {
    expect(redact(null)).toBeNull()
    expect(redact(undefined)).toBeUndefined()
    expect(redact(42)).toBe(42)
    expect(redact(true)).toBe(true)
  })

  test('uses the caller-provided secret values', () => {
    const values = SecretValues.of('sk-caller-supplied-value')
    const out = redact('the value is sk-caller-supplied-value right here', values) as string
    expect(out).toBe(`the value is ${REDACTION_MARKER} right here`)
  })

  test('handles deeply nested credentials without leaking', () => {
    const out = redact({
      result: {
        usage: {
          token: 'sk-bbbbbbbbbbbbbbbb',
        },
        note: 'plain',
      },
    }) as { result: { usage: { token: string }; note: string } }
    expect(out.result.usage.token).toBe(REDACTION_MARKER)
    expect(out.result.note).toBe('plain')
  })
})

describe('redactHeaders', () => {
  test('replaces credential header values entirely', () => {
    const out = redactHeaders({
      authorization: 'Bearer abcdefghijklmnop1234',
      'x-api-key': 'sk-cccccccccccccccc',
      'content-type': 'application/json',
    })
    expect(out.authorization).toBe(REDACTION_MARKER)
    expect(out['x-api-key']).toBe(REDACTION_MARKER)
    expect(out['content-type']).toBe('application/json')
  })

  test('scrubs unknown headers that echo a secret value', () => {
    const out = redactHeaders({
      'x-trace-id': 'Bearer abcdefghijklmnop1234',
    })
    expect(out['x-trace-id']).toBe(`Bearer ${REDACTION_MARKER}`)
  })
})

describe('SecretValues', () => {
  test('ignores values shorter than 4 characters to avoid false matches', () => {
    const values = SecretValues.of('sk')
    expect(values.scrub('this is fine')).toBe('this is fine')
  })

  test('scrubs multiple values in order', () => {
    const values = SecretValues.of('sk-aaaaaaaaaaaaaaaaaaaa', 'sk-bbbbbbbbbbbbbbbb')
    const out = values.scrub('a: sk-aaaaaaaaaaaaaaaaaaaa, b: sk-bbbbbbbbbbbbbbbb')
    expect(out).toBe(`a: ${REDACTION_MARKER}, b: ${REDACTION_MARKER}`)
  })
})