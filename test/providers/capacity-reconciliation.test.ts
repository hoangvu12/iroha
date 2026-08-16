import { describe, expect, test } from 'bun:test'
import {
  reconcileCapacity,
  type CapacityReconciliationInput,
} from '../../src/providers/capacity-reconciliation.ts'
import type { CapacityEvidence } from '../../src/providers/provider-evidence.ts'

const NOW = new Date('2026-08-16T12:00:00.000Z')

function evidence(
  patch: Partial<CapacityEvidence> = {},
): CapacityEvidence {
  return {
    availability: 'available',
    authority: 'authoritative',
    scope: { kind: 'key', keyId: 'key-1' },
    reason: 'positive_entitlement',
    observedAt: NOW,
    freshUntil: new Date(NOW.getTime() + 60_000),
    recheckAt: null,
    facts: { remaining: 1 },
    diagnostics: {},
    ...patch,
  }
}

function input(patch: Partial<CapacityReconciliationInput> = {}): CapacityReconciliationInput {
  return {
    ownerEnabled: true,
    keyId: 'key-1',
    accountId: null,
    model: 'MiniMax-M3',
    existing: {
      health: 'active',
      reason: null,
      retryAfterAt: null,
      scope: 'key',
      scopeId: 'key-1',
      model: null,
    },
    credentialEvidence: null,
    capacityEvidence: [],
    now: NOW,
    jitterMs: () => 0,
    ...patch,
  }
}

describe('capacity reconciliation', () => {
  test.each([0, -0.01])('authoritative remaining %p exhausts and excludes the key', (remaining) => {
    const result = reconcileCapacity(input({
      capacityEvidence: [evidence({
        availability: 'exhausted',
        reason: 'credit_exhausted',
        facts: { remaining },
      })],
    }))

    expect(result.health).toBe('exhausted')
    expect(result.routingEligible).toBe(false)
    expect(result.nextCheckAt).toEqual(new Date('2026-08-16T12:15:00.000Z'))
  })

  test('fresh authoritative positive evidence reactivates an exhausted owner-enabled key', () => {
    const result = reconcileCapacity(input({
      existing: { ...input().existing, health: 'exhausted', reason: 'credit exhausted' },
      credentialEvidence: { verdict: 'authenticated', reason: null },
      capacityEvidence: [evidence()],
    }))

    expect(result.health).toBe('active')
    expect(result.routingEligible).toBe(true)
    expect(result.nextCheckAt).toBeNull()
  })

  test('authentication alone never clears authoritative exhaustion', () => {
    const result = reconcileCapacity(input({
      existing: { ...input().existing, health: 'exhausted', reason: 'window exhausted' },
      credentialEvidence: { verdict: 'authenticated', reason: null },
    }))

    expect(result.health).toBe('exhausted')
    expect(result.routingEligible).toBe(false)
  })

  test('temporary limiting never clears durable authoritative exhaustion', () => {
    const result = reconcileCapacity(input({
      existing: { ...input().existing, health: 'exhausted' },
      capacityEvidence: [evidence({
        availability: 'temporarily_limited',
        reason: 'temporarily_limited',
        recheckAt: new Date(NOW.getTime() + 30_000),
      })],
    }))
    expect(result.health).toBe('exhausted')
    expect(result.routingEligible).toBe(false)
  })

  test('stale and unavailable evidence preserve the prior durable decision', () => {
    const stale = evidence({
      availability: 'exhausted',
      reason: 'credit_exhausted',
      freshUntil: new Date(NOW.getTime() - 1),
      facts: { remaining: 0 },
    })
    expect(reconcileCapacity(input({ capacityEvidence: [stale] })).health).toBe('active')
    expect(reconcileCapacity(input({
      existing: { ...input().existing, health: 'exhausted' },
      capacityEvidence: [evidence({ availability: 'unknown', reason: 'unknown' })],
    })).health).toBe('exhausted')
  })

  test('subscription timestamps only schedule a bounded check and never reactivate', () => {
    const boundary = new Date(NOW.getTime() + 60 * 60_000)
    const result = reconcileCapacity(input({
      existing: { ...input().existing, health: 'exhausted' },
      capacityEvidence: [evidence({
        availability: 'exhausted',
        reason: 'window_exhausted',
        recheckAt: boundary,
        facts: { remainingPercent: 0 },
      })],
      jitterMs: () => 2_000,
    }))

    expect(result.health).toBe('exhausted')
    expect(result.routingEligible).toBe(false)
    expect(result.nextCheckAt).toEqual(new Date('2026-08-16T12:05:00.000Z'))
  })

  test('near subscription boundary receives grace and deterministic jitter', () => {
    const result = reconcileCapacity(input({
      capacityEvidence: [evidence({
        availability: 'exhausted',
        reason: 'window_exhausted',
        recheckAt: new Date(NOW.getTime() + 60_000),
        facts: { remainingPercent: 0 },
      })],
      jitterMs: () => 3_000,
    }))

    expect(result.nextCheckAt).toEqual(new Date(NOW.getTime() + 68_000))
  })

  test('owner disable and invalid authentication take precedence over positive capacity', () => {
    expect(reconcileCapacity(input({ ownerEnabled: false, capacityEvidence: [evidence()] })).health)
      .toBe('disabled')
    expect(reconcileCapacity(input({
      credentialEvidence: { verdict: 'rejected', reason: 'rejected' },
      capacityEvidence: [evidence()],
    })).health).toBe('invalid_authentication')
    expect(reconcileCapacity(input({
      existing: { ...input().existing, health: 'invalid_authentication' },
      credentialEvidence: { verdict: 'authenticated', reason: null },
      capacityEvidence: [evidence()],
    })).health).toBe('invalid_authentication')
  })

  test('model-scoped evidence only affects its exact model', () => {
    const scoped = evidence({ scope: { kind: 'connection_model', model: 'MiniMax-M2' } })
    expect(reconcileCapacity(input({ capacityEvidence: [scoped] })).health).toBe('active')
    expect(reconcileCapacity(input({ model: 'MiniMax-M2', capacityEvidence: [scoped] })).health)
      .toBe('active')

    const exhausted = { ...scoped, availability: 'exhausted', reason: 'window_exhausted' } as const
    expect(reconcileCapacity(input({ capacityEvidence: [exhausted] })).routingEligible).toBe(true)
    expect(reconcileCapacity(input({ model: 'MiniMax-M2', capacityEvidence: [exhausted] })).routingEligible)
      .toBe(false)
  })

  test('positive evidence for one model preserves another model cooldown', () => {
    const result = reconcileCapacity(input({
      model: 'MiniMax-M2',
      existing: {
        ...input().existing,
        health: 'cooling_down',
        scope: 'connection_model',
        model: 'MiniMax-M3',
      },
      capacityEvidence: [evidence({ scope: { kind: 'connection_model', model: 'MiniMax-M2' } })],
    }))
    expect(result.health).toBe('cooling_down')
    expect(result.routingEligible).toBe(true)
  })

  test('account, provider, key, and unknown scopes apply conservatively', () => {
    const exhausted = (scope: CapacityEvidence['scope']) => evidence({
      availability: 'exhausted', reason: 'credit_exhausted', facts: { remaining: 0 }, scope,
    })
    expect(reconcileCapacity(input({ accountId: 'a', capacityEvidence: [exhausted({ kind: 'account', accountId: 'a' })] })).routingEligible).toBe(false)
    expect(reconcileCapacity(input({ accountId: 'b', capacityEvidence: [exhausted({ kind: 'account', accountId: 'a' })] })).routingEligible).toBe(true)
    expect(reconcileCapacity(input({ capacityEvidence: [exhausted({ kind: 'provider' })] })).routingEligible).toBe(false)
    expect(reconcileCapacity(input({ capacityEvidence: [exhausted({ kind: 'unknown' })] })).routingEligible).toBe(true)
  })
})
