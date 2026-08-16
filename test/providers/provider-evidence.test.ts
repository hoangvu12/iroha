import { describe, expect, test } from 'bun:test'
import {
  providerDiagnosticsOf,
  type CapacityEvidence,
  type ProviderDiagnostics,
} from '../../src/providers/index.ts'

describe('normalized Provider evidence', () => {
  test('represents authoritative capacity without Provider-specific fields', () => {
    const evidence: CapacityEvidence = {
      availability: 'exhausted',
      authority: 'authoritative',
      scope: { kind: 'key', keyId: 'key-1' },
      reason: 'credit_exhausted',
      observedAt: new Date('2026-08-16T00:00:00.000Z'),
      freshUntil: new Date('2026-08-16T00:01:00.000Z'),
      recheckAt: new Date('2026-08-16T00:15:00.000Z'),
      facts: { remaining: -0.5, unit: 'CNY' },
      diagnostics: providerDiagnosticsOf({ status: 429, providerCode: '1008' }),
    }

    expect(evidence.scope).toEqual({ kind: 'key', keyId: 'key-1' })
    expect(evidence.facts.remaining).toBe(-0.5)
  })

  test('keeps only bounded allow-listed diagnostics from unknown input', () => {
    const secret = 'sk-secret-from-provider-body'
    const diagnostics = providerDiagnosticsOf({
      status: 429,
      providerCode: `code-${'x'.repeat(200)}`,
      providerType: 'rate_limit',
      limitingWindow: 'weekly',
      retryAfterSeconds: 12.5,
      remaining: 0,
      remainingPercent: 0,
      message: `arbitrary ${secret}`,
      body: { prompt: secret, completion: secret },
      headers: { authorization: `Bearer ${secret}` },
      unknown: secret,
    })

    expect(diagnostics).toEqual({
      status: 429,
      providerCode: `code-${'x'.repeat(59)}`,
      providerType: 'rate_limit',
      limitingWindow: 'weekly',
      retryAfterSeconds: 12.5,
      remaining: 0,
      remainingPercent: 0,
    } satisfies ProviderDiagnostics)
    expect(JSON.stringify(diagnostics)).not.toContain(secret)
  })

  test('drops malformed allow-listed values instead of coercing them', () => {
    expect(providerDiagnosticsOf({
      status: '429',
      providerCode: { raw: 'unsafe' },
      retryAfterSeconds: Number.POSITIVE_INFINITY,
      remaining: Number.NaN,
      observedAt: 'not allow-listed',
    })).toEqual({})
    expect(providerDiagnosticsOf(null)).toEqual({})
    expect(providerDiagnosticsOf('raw body')).toEqual({})
  })
})
