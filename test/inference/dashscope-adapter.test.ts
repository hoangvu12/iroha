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

  describe('a key that cannot call the requested model', () => {
    // The three signatures observed across the entitlement tiers of one real
    // DashScope Provider. All three must reach another Upstream Key.
    const signatures = [
      {
        name: '400 invalid_parameter_error',
        status: 400,
        error: { code: 'invalid_parameter_error', message: 'model `deepseek-v3.2` is not supported.', param: null, type: 'invalid_request_error' },
      },
      {
        name: '404 model_not_found',
        status: 404,
        error: { code: 'model_not_found', message: 'The model `MiniMax-M2.5` does not exist or you do not have access to it.', param: null, type: 'invalid_request_error' },
      },
      {
        name: '404 model_not_supported',
        status: 404,
        error: { code: 'model_not_supported', message: 'Unsupported model `text-embedding-v3` for OpenAI compatibility mode.', param: null, type: 'invalid_request_error' },
      },
    ] as const

    for (const signature of signatures) {
      test(`tries an alternate for ${signature.name}`, () => {
        const classification = adapter.classifyFailure({
          kind: 'buffered',
          status: signature.status,
          headers: {},
          body: JSON.stringify({ error: signature.error }),
        })

        expect(classification).toEqual({
          kind: 'model_unavailable',
          capacityScope: 'unknown',
          retryAction: 'try_alternate',
          retryAfterSeconds: null,
        })
      })
    }

    test('reads the signature through the streaming safe-error wrapper', () => {
      const classification = adapter.classifyFailure({
        kind: 'buffered',
        status: 404,
        headers: {},
        body: JSON.stringify({ error: { code: 'upstream_not_found', upstream_code: 'model_not_found' } }),
      })

      expect(classification.kind).toBe('model_unavailable')
      expect(classification.retryAction).toBe('try_alternate')
    })

    test('leaves an ordinary bad parameter alone', () => {
      // Same code as the 400 signature, different message. Walking every key
      // for a malformed temperature would waste the whole retry budget.
      const classification = adapter.classifyFailure({
        kind: 'buffered',
        status: 400,
        headers: {},
        body: JSON.stringify({
          error: { code: 'invalid_parameter_error', message: 'The value of temperature must be in [0, 2).' },
        }),
      })

      expect(classification.kind).toBe('request_rejected')
      expect(classification.retryAction).toBe('stop')
    })
  })
})
