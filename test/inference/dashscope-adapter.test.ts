import { describe, expect, test } from 'bun:test'
import { createDashscopeInferenceAdapter } from '../../src/inference/dashscope-adapter.ts'

describe('DashScope inference adapter', () => {
  const adapter = createDashscopeInferenceAdapter()

  test('tries an alternate for a native data inspection failure', () => {
    const classification = adapter.classifyFailure({
      kind: 'buffered',
      status: 400,
      headers: {},
      body: JSON.stringify({
        error: { code: 'data_inspection_failed', message: 'Input data may contain inappropriate content.' },
      }),
    })

    expect(classification).toEqual({
      kind: 'content_inspection_failed',
      capacityScope: 'unknown',
      retryAction: 'try_alternate',
      retryAfterSeconds: null,
    })
  })

  test('recognises the safe error wrapper used by streaming inference', () => {
    const classification = adapter.classifyFailure({
      kind: 'buffered',
      status: 400,
      headers: {},
      body: JSON.stringify({ error: { code: 'upstream_bad_request', upstream_code: 'data_inspection_failed' } }),
    })

    expect(classification.kind).toBe('content_inspection_failed')
    expect(classification.retryAction).toBe('try_alternate')
  })

  test('does not retry unrelated validation failures', () => {
    const classification = adapter.classifyFailure({
      kind: 'buffered',
      status: 400,
      headers: {},
      body: JSON.stringify({ error: { code: 'invalid_parameter_error' } }),
    })

    expect(classification.kind).toBe('request_rejected')
    expect(classification.retryAction).toBe('stop')
  })
})
