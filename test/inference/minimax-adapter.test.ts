import { describe, expect, test } from 'bun:test'
import inference402 from '../fixtures/minimax/inference-402.json'
import inference429 from '../fixtures/minimax/inference-429.json'
import { createMinimaxInferenceAdapter } from '../../src/inference/minimax-adapter.ts'

const observedAt = new Date('2026-08-16T05:00:00.000Z')

describe('MiniMax text inference adapter', () => {
  const adapter = createMinimaxInferenceAdapter()

  test('emits provisional key-scoped evidence for a structured 402', () => {
    const classification = adapter.classifyFailure(
      { kind: 'buffered', status: 402, headers: {}, body: JSON.stringify(inference402) },
      { keyId: 'key-1', observedAt },
    )

    expect(classification).toEqual({
      kind: 'payment_required',
      capacityScope: 'key',
      retryAction: 'try_alternate',
      retryAfterSeconds: null,
      diagnostics: {
        status: 402,
        providerCode: 'insufficient_balance',
        providerType: 'payment_required',
        classification: 'payment_required',
        capacityScope: 'key',
        evidenceAuthority: 'provisional',
        evidenceObservedAt: observedAt.toISOString(),
        evidenceFreshUntil: observedAt.toISOString(),
      },
      capacityEvidence: {
        availability: 'exhausted',
        authority: 'provisional',
        scope: { kind: 'key', keyId: 'key-1' },
        reason: 'unknown',
        observedAt,
        freshUntil: observedAt,
        recheckAt: null,
        facts: {},
        diagnostics: {
          status: 402,
          providerCode: 'insufficient_balance',
          providerType: 'payment_required',
          classification: 'payment_required',
          capacityScope: 'key',
          evidenceAuthority: 'provisional',
          evidenceObservedAt: observedAt.toISOString(),
          evidenceFreshUntil: observedAt.toISOString(),
        },
      },
    })
    expect(JSON.stringify(classification)).not.toContain('sensitive provider text')
  })

  test('emits provisional limited evidence and bounded retry timing for a structured 429', () => {
    const classification = adapter.classifyFailure(
      {
        kind: 'buffered', status: 429,
        headers: { 'retry-after': '45' }, body: JSON.stringify(inference429),
      },
      { keyId: 'key-2', observedAt },
    )

    expect(classification.kind).toBe('capacity_limited')
    expect(classification.capacityScope).toBe('key')
    expect(classification.retryAfterSeconds).toBe(45)
    expect(classification.capacityEvidence).toMatchObject({
      availability: 'temporarily_limited', authority: 'provisional',
      scope: { kind: 'key', keyId: 'key-2' }, reason: 'temporarily_limited',
    })
    expect(classification.diagnostics).toEqual({
      status: 429,
      providerCode: 'rate_limit_exceeded',
      providerType: 'rate_limit_error',
      classification: 'capacity_limited',
      capacityScope: 'key',
      evidenceAuthority: 'provisional',
      evidenceObservedAt: observedAt.toISOString(),
      evidenceFreshUntil: observedAt.toISOString(),
      retryAfterSeconds: 45,
      retryAt: '2026-08-16T05:00:45.000Z',
    })
  })

  test('keeps bare and malformed 402/429 conservative', () => {
    for (const [status, body] of [[402, 'not-json'], [429, '{}']] as const) {
      const classification = adapter.classifyFailure(
        { kind: 'buffered', status, headers: {}, body },
        { keyId: 'key-3', observedAt },
      )
      expect(classification.capacityScope).toBe('unknown')
      expect(classification.capacityEvidence).toBeUndefined()
      expect(classification.diagnostics).toBeUndefined()
    }
  })

  test('ignores structured envelopes outside MiniMax 402/429 handling', () => {
    const classification = adapter.classifyFailure({
      kind: 'buffered', status: 400, headers: {}, body: JSON.stringify(inference402),
    }, { keyId: 'key-4', observedAt })
    expect(classification).toEqual({
      kind: 'request_rejected', capacityScope: 'unknown', retryAction: 'stop', retryAfterSeconds: null,
    })
  })
})
