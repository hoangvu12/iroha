import { describe, expect, test } from 'bun:test'
import { createNousResearchInferenceAdapter } from '../../src/inference/nousresearch-adapter.ts'

const observedAt = new Date('2026-09-26T12:49:30.000Z')
const context = { keyId: 'key-1', observedAt }
const failure = (status: number, body: unknown) => ({
  kind: 'buffered' as const,
  status,
  headers: {},
  body: typeof body === 'string' ? body : JSON.stringify(body),
})

/** The exact production body (2026-09-26): a flat envelope on HTTP 404. */
const insufficientCredits = () => failure(404, {
  status: 404,
  message: 'Model requires available credits. Your account balance is too low to use paid models.',
  code: 'insufficient_credits_for_paid_model',
})

describe('Nous Research inference error classification', () => {
  test('exhausts a key whose account has no credits for paid models', () => {
    const classification = createNousResearchInferenceAdapter().classifyFailure(
      insufficientCredits(),
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
        status: 404,
        providerCode: 'insufficient_credits_for_paid_model',
        classification: 'payment_required',
        capacityScope: 'key',
      },
    })
  })

  test('a bare 404 without the code keeps the generic model-unavailable reading', () => {
    // A real "key does not carry this model" 404 is the failure-classification
    // spec's to interpret, not a billing condition.
    const classification = createNousResearchInferenceAdapter().classifyFailure(
      failure(404, { status: 404, message: 'Not found', code: 'model_not_found' }),
      context,
    )
    expect(classification).toMatchObject({ kind: 'request_rejected', capacityScope: 'connection_model' })
    expect(classification.capacityEvidence).toBeUndefined()
  })

  test('the credits code on another status is not a payment refusal', () => {
    const classification = createNousResearchInferenceAdapter().classifyFailure(
      failure(429, { status: 429, message: 'slow down', code: 'insufficient_credits_for_paid_model' }),
      context,
    )
    expect(classification).toMatchObject({ kind: 'capacity_limited', capacityScope: 'unknown' })
    expect(classification.capacityEvidence).toBeUndefined()
  })

  test('requires a failure context before scoping capacity to a key', () => {
    const classification = createNousResearchInferenceAdapter().classifyFailure(insufficientCredits())
    expect(classification).toMatchObject({ kind: 'request_rejected', capacityScope: 'connection_model' })
    expect(classification.capacityEvidence).toBeUndefined()
  })

  test('an envelope without a code and an empty body fall through to the generic classifier', () => {
    const noCode = createNousResearchInferenceAdapter().classifyFailure(
      failure(404, { status: 404, message: 'Not found' }),
      context,
    )
    expect(noCode).toMatchObject({ kind: 'request_rejected' })
    expect(noCode.capacityEvidence).toBeUndefined()

    const empty = createNousResearchInferenceAdapter().classifyFailure(failure(404, ''), context)
    expect(empty).toMatchObject({ kind: 'request_rejected' })
    expect(empty.capacityEvidence).toBeUndefined()
  })
})
