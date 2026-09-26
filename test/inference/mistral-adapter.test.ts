import { describe, expect, test } from 'bun:test'
import { createMistralInferenceAdapter } from '../../src/inference/mistral-adapter.ts'

const observedAt = new Date('2026-09-26T22:29:59.000Z')
const context = { keyId: 'key-1', observedAt }
const failure = (status: number, error: Record<string, unknown> = {}) => ({
  kind: 'buffered' as const,
  status,
  headers: {},
  body: JSON.stringify({ object: 'error', message: 'do not persist me', param: null, ...error }),
})

describe('Mistral inference error classification', () => {
  test('exhausts a key whose customer monthly spending limit is reached', () => {
    // The exact production body (2026-09-26, key uk_hTV8Y5vKKnnURso_0HQOjg):
    // HTTP 402 with type billing_customer_monthly_spending_limit_reached and
    // code 2300. The generic 402 reading asserts no capacity, so the key
    // burned the first Attempt of every Mistral Request until the Owner
    // noticed.
    const classification = createMistralInferenceAdapter().classifyFailure(
      failure(402, {
        type: 'billing_customer_monthly_spending_limit_reached',
        code: '2300',
        raw_status_code: 402,
      }),
      context,
    )
    expect(classification).toMatchObject({
      kind: 'payment_required',
      capacityScope: 'key',
      retryAction: 'try_alternate',
      capacityEvidence: {
        availability: 'exhausted',
        authority: 'provisional',
        scope: { kind: 'key', keyId: 'key-1' },
        reason: 'credit_exhausted',
        recheckAt: null,
      },
      diagnostics: {
        status: 402,
        providerCode: '2300',
        providerType: 'billing_customer_monthly_spending_limit_reached',
        classification: 'payment_required',
        capacityScope: 'key',
      },
    })
  })

  test('recognizes the billing family by envelope type, not by status alone', () => {
    // A bare 402 without the billing family keeps the generic reading: status
    // alone cannot distinguish a spending cap from anything else a Provider
    // might mean by it.
    const bare = createMistralInferenceAdapter().classifyFailure(failure(402), context)
    expect(bare).toMatchObject({ kind: 'payment_required', capacityScope: 'unknown' })
    expect(bare.capacityEvidence).toBeUndefined()
  })

  test('a billing type outside HTTP 402 is not a payment refusal', () => {
    const classification = createMistralInferenceAdapter().classifyFailure(
      failure(429, { type: 'billing_customer_monthly_spending_limit_reached', code: '2300' }),
      context,
    )
    expect(classification).toMatchObject({ kind: 'capacity_limited', capacityScope: 'unknown' })
    expect(classification.capacityEvidence).toBeUndefined()
  })

  test('an unrecognized error envelope keeps the generic classification', () => {
    // Observed in production: an invalid model is HTTP 400 with type
    // invalid_model and code 1500. Nothing Mistral-specific to assert.
    const classification = createMistralInferenceAdapter().classifyFailure(
      failure(400, { type: 'invalid_model', code: '1500' }),
      context,
    )
    expect(classification).toMatchObject({ kind: 'request_rejected', retryAction: 'stop' })
    expect(classification.capacityEvidence).toBeUndefined()
  })

  test('requires a failure context before scoping capacity to a key', () => {
    const classification = createMistralInferenceAdapter().classifyFailure(
      failure(402, { type: 'billing_customer_monthly_spending_limit_reached', code: '2300' }),
    )
    expect(classification).toMatchObject({ kind: 'payment_required', capacityScope: 'unknown' })
    expect(classification.capacityEvidence).toBeUndefined()
  })

  test('an empty body falls through to the generic classifier', () => {
    const classification = createMistralInferenceAdapter().classifyFailure({
      kind: 'buffered',
      status: 402,
      headers: {},
      body: '',
    }, context)
    expect(classification).toMatchObject({ kind: 'payment_required', capacityScope: 'unknown' })
    expect(classification.capacityEvidence).toBeUndefined()
  })
})
