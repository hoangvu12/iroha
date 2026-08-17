import { describe, expect, test } from 'bun:test'
import { createZaiInferenceAdapter } from '../../src/inference/zai-adapter.ts'

const observedAt = new Date('2026-08-17T00:00:00.000Z')
const context = { keyId: 'key-1', observedAt }
const failure = (status: number, code: string, extra: Record<string, unknown> = {}) => ({
  kind: 'buffered' as const,
  status,
  headers: {},
  body: JSON.stringify({ error: { code, ...extra } }),
})

describe('Z.ai inference error classification', () => {
  test.each([
    ['1000', 'authentication_invalid', 'key', 'try_alternate'],
    ['1001', 'authentication_invalid', 'key', 'try_alternate'],
    ['1002', 'authentication_invalid', 'key', 'try_alternate'],
    ['1003', 'authentication_invalid', 'key', 'try_alternate'],
    ['1004', 'authentication_invalid', 'key', 'try_alternate'],
    ['1005', 'authentication_invalid', 'key', 'try_alternate'],
  ] as const)('classifies documented authentication code %s', (code, kind, scope, retryAction) => {
    expect(createZaiInferenceAdapter().classifyFailure(failure(401, code), context)).toMatchObject({
      kind, capacityScope: scope, retryAction, diagnostics: { providerCode: code },
    })
  })

  test.each(['1210', '1211', '1212', '1213', '1214', '1215', '1221', '1222', '1231', '1261', '1300', '1301'])(
    'stops on documented request error %s',
    (code) => {
      expect(createZaiInferenceAdapter().classifyFailure(failure(400, code), context)).toMatchObject({
        kind: 'request_rejected', retryAction: 'stop', diagnostics: { providerCode: code },
      })
    },
  )

  test.each(['1200', '1230', '1234'])('retries documented provider failure %s', (code) => {
    expect(createZaiInferenceAdapter().classifyFailure(failure(500, code), context)).toMatchObject({
      kind: 'provider_failure', capacityScope: 'connection_model', retryAction: 'retry_same',
      diagnostics: { providerCode: code },
    })
  })

  test('treats 1305 overload as transient Provider capacity', () => {
    const classification = createZaiInferenceAdapter().classifyFailure(failure(429, '1305'), context)
    expect(classification).toMatchObject({
      kind: 'capacity_limited', capacityScope: 'provider', retryAction: 'retry_same',
      diagnostics: { providerCode: '1305' },
    })
    expect(classification.capacityEvidence).toBeUndefined()
  })

  test('treats the BigModel daily limit as provisional key capacity', () => {
    expect(createZaiInferenceAdapter().classifyFailure(failure(429, '1304'), context)).toMatchObject({
      kind: 'capacity_limited', capacityScope: 'key', retryAction: 'try_alternate',
      capacityEvidence: { availability: 'temporarily_limited' },
      diagnostics: { providerCode: '1304', limitingWindow: 'daily' },
    })
  })

  test.each(['1309', '1314'])('exhausts an expired plan for code %s', (code) => {
    expect(createZaiInferenceAdapter().classifyFailure(failure(429, code), context)).toMatchObject({
      kind: 'payment_required', capacityScope: 'key', retryAction: 'try_alternate',
      capacityEvidence: { availability: 'exhausted', scope: { kind: 'key', keyId: 'key-1' } },
    })
  })

  test('rotates away from a key for the wrong product type', () => {
    expect(createZaiInferenceAdapter().classifyFailure(failure(429, '1315'), context)).toMatchObject({
      kind: 'authentication_rejected', capacityScope: 'key', retryAction: 'try_alternate',
      diagnostics: { providerCode: '1315' },
    })
  })

  test.each(['1308', '1310', '1316', '1317', '1318', '1319', '1320', '1321'])(
    'defensively accepts a structured reset time for capacity code %s',
    (code) => {
      const classification = createZaiInferenceAdapter().classifyFailure(
        failure(429, code, { next_flush_time: '2026-08-17T05:00:00.000Z' }), context,
      )
      expect(classification.capacityEvidence?.recheckAt).toEqual(new Date('2026-08-17T05:00:00.000Z'))
    },
  )
})
