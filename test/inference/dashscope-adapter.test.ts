import { describe, expect, test } from 'bun:test'
import { createDashscopeInferenceAdapter } from '../../src/inference/dashscope-adapter.ts'

describe('DashScope inference adapter', () => {
  const adapter = createDashscopeInferenceAdapter()
  const context = { keyId: 'uk_overdue', observedAt: new Date('2026-08-18T10:17:32.578Z') }

  test('tries an alternate for a native data inspection failure', () => {
    const classification = adapter.classifyFailure({
      kind: 'buffered',
      status: 400,
      headers: {},
      body: JSON.stringify({
        error: { code: 'data_inspection_failed', message: 'Input data may contain inappropriate content.' },
      }),
    })

    expect(classification).toMatchObject({
      kind: 'content_inspection_failed',
      capacityScope: 'unknown',
      retryAction: 'try_alternate',
      retryAfterSeconds: null,
    })
    expect(classification.capacityEvidence).toBeUndefined()
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

  describe('a key whose account is overdue', () => {
    // DashScope answers an unpaid account with 400, not the 402 the generic
    // adapter reads as billing. Left generic, the Request stops on a failure
    // every other Upstream Key of the Provider could have served.
    const arrearage = {
      code: 'Arrearage',
      type: 'Arrearage',
      param: null,
      message: 'Access denied, please make sure your account is in good standing.',
    }

    test('reaches an alternate key instead of failing the Request', () => {
      const classification = adapter.classifyFailure(
        { kind: 'buffered', status: 400, headers: {}, body: JSON.stringify({ error: arrearage }) },
        context,
      )

      expect(classification).toMatchObject({
        kind: 'payment_required',
        capacityScope: 'key',
        retryAction: 'try_alternate',
      })
    })

    test('claims key-scoped exhaustion so Key Health can park the credential', () => {
      const classification = adapter.classifyFailure(
        { kind: 'buffered', status: 400, headers: {}, body: JSON.stringify({ error: arrearage }) },
        context,
      )

      expect(classification.capacityEvidence).toMatchObject({
        availability: 'exhausted',
        authority: 'provisional',
        scope: { kind: 'key', keyId: 'uk_overdue' },
        reason: 'credit_exhausted',
        // An unpaid balance clears when the Owner pays, not on a timer.
        recheckAt: null,
      })
    })

    test('reads the signature through the streaming safe-error wrapper', () => {
      const classification = adapter.classifyFailure(
        {
          kind: 'buffered',
          status: 400,
          headers: {},
          body: JSON.stringify({
            error: { code: 'upstream_bad_request', upstream_code: 'Arrearage', upstream_type: 'Arrearage' },
          }),
        },
        context,
      )

      expect(classification.kind).toBe('payment_required')
      expect(classification.retryAction).toBe('try_alternate')
    })

    test('claims nothing without the context that names the key', () => {
      // Capacity Evidence is scoped to an Upstream Key. With no key to name,
      // the reading would have to guess at a scope, so none is emitted.
      const classification = adapter.classifyFailure({
        kind: 'buffered',
        status: 400,
        headers: {},
        body: JSON.stringify({ error: arrearage }),
      })

      expect(classification.kind).toBe('request_rejected')
      expect(classification.capacityEvidence).toBeUndefined()
    })
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

        expect(classification).toMatchObject({
          kind: 'model_unavailable',
          capacityScope: 'unknown',
          retryAction: 'try_alternate',
          retryAfterSeconds: null,
        })
        // Entitlement is not capacity: a key that lacks a model is healthy.
        expect(classification.capacityEvidence).toBeUndefined()
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

  describe('Provider Diagnostics', () => {
    // Every DashScope failure used to reach the request history as `{}`, so an
    // Owner could not tell an overdue account from a content rejection without
    // probing the key by hand.
    test('retain the envelope identifiers behind a classified failure', () => {
      const classification = adapter.classifyFailure(
        {
          kind: 'buffered',
          status: 400,
          headers: {},
          body: JSON.stringify({ error: { code: 'Arrearage', type: 'Arrearage' } }),
        },
        context,
      )

      expect(classification.diagnostics).toEqual({
        status: 400,
        providerCode: 'Arrearage',
        providerType: 'Arrearage',
        classification: 'payment_required',
        capacityScope: 'key',
        evidenceAuthority: 'provisional',
        evidenceObservedAt: context.observedAt.toISOString(),
        evidenceFreshUntil: context.observedAt.toISOString(),
      })
    })

    test('name an unclassified failure without asserting capacity', () => {
      const classification = adapter.classifyFailure(
        {
          kind: 'buffered',
          status: 400,
          headers: {},
          body: JSON.stringify({ error: { code: 'invalid_parameter_error', type: 'invalid_request_error' } }),
        },
        context,
      )

      expect(classification.diagnostics).toMatchObject({
        status: 400,
        providerCode: 'invalid_parameter_error',
        providerType: 'invalid_request_error',
        classification: 'request_rejected',
      })
      expect(classification.capacityEvidence).toBeUndefined()
    })

    test('carry no message, however useful it looked', () => {
      const classification = adapter.classifyFailure(
        {
          kind: 'buffered',
          status: 400,
          headers: {},
          body: JSON.stringify({
            error: { code: 'Arrearage', message: 'Access denied, sk-do-not-persist-me-1234' },
          }),
        },
        context,
      )

      expect(JSON.stringify(classification.diagnostics)).not.toContain('sk-do-not-persist-me')
      expect(JSON.stringify(classification.diagnostics)).not.toContain('Access denied')
    })

    test('stay absent when the Provider named nothing', () => {
      const classification = adapter.classifyFailure(
        { kind: 'buffered', status: 500, headers: {}, body: 'upstream exploded' },
        context,
      )

      expect(classification.diagnostics).toBeUndefined()
    })
  })
})
