import { describe, expect, test } from 'bun:test'
import {
  createDeepaiUsageAdapter,
  deepaiCapacityEvidenceOf,
  deepaiEntitlementUrl,
  deepaiUsageReadings,
} from '../../src/usage/deepai-usage-adapter.ts'
import { reconcileCapacity } from '../../src/providers/capacity-reconciliation.ts'

const KEY = 'test-upstream-key'
const BASE_URL = 'https://deepai-proxy.example/v1'

/**
 * Real entitlement bodies from a deepai-proxy deployment, trimmed to the
 * documented surface. The amounts are fixed-precision strings because that is
 * how the gateway reports them.
 */
const HEALTHY_BODY = {
  enabled: true,
  balance: '30.45602',
  granted: '50.00000',
  refresh_at: '2026-11-17T21:45:47+00:00',
  lane_version: 7,
  check_in: { nonce: 'cfb852d81e1786e029e492b28b9cf070', seconds: 600 },
}

const SPENT_BODY = {
  enabled: true,
  balance: '0.00000',
  granted: '50.00000',
  refresh_at: '2026-11-17T21:45:47+00:00',
  lane_version: 7,
}

const NO_GRANT_BODY = {
  enabled: true,
  balance: '0.00000',
  granted: '0.00000',
  refresh_at: '2026-11-18T09:08:33+00:00',
  lane_version: 7,
}

const respond = (body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch

describe('the DeepAI Usage Adapter', () => {
  test('reads the Theos allowance with Bearer auth', async () => {
    let url = ''
    let authorization = ''
    const adapter = createDeepaiUsageAdapter({ fetch: (async (input: Request | string | URL, init?: RequestInit) => {
      url = String(input)
      authorization = ((init?.headers ?? {}) as Record<string, string>).authorization ?? ''
      return new Response(JSON.stringify(HEALTHY_BODY), { status: 200 })
    }) as typeof fetch })

    const result = await adapter.read({ baseUrl: BASE_URL, allowInsecureHttp: false, upstreamKey: KEY })

    expect(adapter.visibility).toBe('authoritative')
    expect(url).toBe('https://deepai-proxy.example/v1/theos')
    expect(authorization).toBe(`Bearer ${KEY}`)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.readings).toHaveLength(1)
    expect(result.readings[0]).toMatchObject({
      unit: 'Theos',
      balance: 30.45602,
      limit: 50,
      used: 19.54398,
      confidence: 'confirmed',
      scope: { kind: 'key', keyId: '' },
      resetAt: new Date('2026-11-17T21:45:47+00:00'),
    })
    expect(result.readings[0]?.remainingPercent).toBeCloseTo(60.91204, 4)
  })

  test('resolves the entitlement path against the Provider base URL', () => {
    expect(deepaiEntitlementUrl('https://gateway.example/v1')).toBe('https://gateway.example/v1/theos')
    expect(deepaiEntitlementUrl('https://gateway.example/v1/')).toBe('https://gateway.example/v1/theos')
    expect(deepaiEntitlementUrl('https://gateway.example')).toBe('https://gateway.example/theos')
  })

  test('a spent allowance is authoritative key-scoped exhaustion with its reset', () => {
    const readings = deepaiUsageReadings(SPENT_BODY)
    expect(readings).toHaveLength(1)
    const evidence = deepaiCapacityEvidenceOf(readings[0]!, 'key-1', new Date('2026-11-17T12:00:00.000Z'))
    expect(evidence).toMatchObject({
      availability: 'exhausted',
      authority: 'authoritative',
      scope: { kind: 'key', keyId: 'key-1' },
      reason: 'credit_exhausted',
      recheckAt: new Date('2026-11-17T21:45:47+00:00'),
    })
  })

  test('reconciliation keeps a spent key parked instead of resurrecting it', () => {
    const evidence = deepaiUsageReadings(SPENT_BODY).map((reading) =>
      deepaiCapacityEvidenceOf(reading, 'key-1', new Date('2026-11-17T12:00:00.000Z')))
    const decision = reconcileCapacity({
      ownerEnabled: true,
      keyId: 'key-1',
      accountId: null,
      model: null,
      existing: {
        health: 'exhausted',
        reason: 'upstream HTTP 429',
        retryAfterAt: new Date('2026-11-17T12:30:00.000Z'),
        scope: 'key',
        scopeId: 'key-1',
        model: null,
      },
      credentialEvidence: null,
      capacityEvidence: evidence,
      now: new Date('2026-11-17T12:00:00.000Z'),
    })
    expect(decision.health).toBe('exhausted')
    expect(decision.routingEligible).toBe(false)
  })

  test('an allowance with Theos left is available capacity', () => {
    const readings = deepaiUsageReadings(HEALTHY_BODY)
    const evidence = deepaiCapacityEvidenceOf(readings[0]!, 'key-1', new Date('2026-11-17T12:00:00.000Z'))
    expect(evidence).toMatchObject({
      availability: 'available',
      authority: 'authoritative',
      reason: 'positive_entitlement',
    })
  })

  test('an account with no grant reads as exhausted rather than unknown', () => {
    // A zero balance with a zero grant is a confirmed absence: the day's
    // Theos have not arrived yet, and the reset time says when they will.
    const readings = deepaiUsageReadings(NO_GRANT_BODY)
    expect(readings).toHaveLength(1)
    const evidence = deepaiCapacityEvidenceOf(readings[0]!, 'key-1', new Date('2026-11-17T12:00:00.000Z'))
    expect(evidence).toMatchObject({ availability: 'exhausted', authority: 'authoritative' })
    expect(evidence.recheckAt).toEqual(new Date('2026-11-18T09:08:33+00:00'))
  })

  test('a body without the amounts is a parse failure, never a zero balance', () => {
    expect(deepaiUsageReadings({ enabled: true })).toHaveLength(0)
    expect(deepaiUsageReadings({ balance: '1.00000', granted: 'not a number' })).toHaveLength(0)
    expect(deepaiUsageReadings(null)).toHaveLength(0)
    expect(deepaiUsageReadings([1, 2, 3])).toHaveLength(0)
  })

  test('a refused poll reports the refusal rather than an exhausted key', async () => {
    const adapter = createDeepaiUsageAdapter({ fetch: (async () =>
      new Response('nope', { status: 403 })) as unknown as typeof fetch })
    const result = await adapter.read({ baseUrl: BASE_URL, allowInsecureHttp: false, upstreamKey: KEY })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toEqual({
      code: 'upstream_refused',
      status: 403,
      message: 'DeepAI entitlement endpoint refused (HTTP 403)',
    })
  })

  describe('a key whose daily pool is spent', () => {
    // The upstream answers with 403 and names the exhaustion, and says when the
    // pool refills. That is a known state, not a broken read: reporting it as a
    // failure would leave the row blank and the key looking usable.
    const SPENT_BODY = {
      error: {
        message: 'Free daily Theos are not available right now. Try again at 2026-11-18T12:01:30+00:00.',
        type: 'network_bound',
        code: 'network_bound',
      },
    }

    test('reads as a confirmed zero with the reset the upstream names', async () => {
      const adapter = createDeepaiUsageAdapter({ fetch: (async () =>
        new Response(JSON.stringify(SPENT_BODY), { status: 403 })) as unknown as typeof fetch })
      const result = await adapter.read({ baseUrl: BASE_URL, allowInsecureHttp: false, upstreamKey: KEY })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.readings).toHaveLength(1)
      expect(result.readings[0]).toMatchObject({
        unit: 'Theos',
        balance: 0,
        limit: null,
        remainingPercent: 0,
        resetAt: new Date('2026-11-18T12:01:30Z'),
        confidence: 'confirmed',
      })
    })

    test('the key is retired until the pool refills', () => {
      const reading = deepaiUsageReadings({
        balance: '0.00000',
        granted: '0.00000',
        refresh_at: '2026-11-18T12:01:30+00:00',
      })[0]!
      const evidence = deepaiCapacityEvidenceOf(reading, 'key-1', new Date('2026-11-17T12:00:00.000Z'))
      expect(evidence).toMatchObject({
        availability: 'exhausted',
        authority: 'authoritative',
        reason: 'credit_exhausted',
        recheckAt: new Date('2026-11-18T12:01:30Z'),
      })
    })

    test('a refusal with an unknown code stays a refusal', async () => {
      const adapter = createDeepaiUsageAdapter({ fetch: (async () =>
        new Response(JSON.stringify({ error: { code: 'something_else', message: 'no' } }), { status: 403 })) as unknown as typeof fetch })
      const result = await adapter.read({ baseUrl: BASE_URL, allowInsecureHttp: false, upstreamKey: KEY })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.failure.code).toBe('upstream_refused')
    })
  })

  describe('a key whose check-in is refused', () => {
    // The body the upstream answers, verbatim. The refusal is about the check-in,
    // not the account: model calls on the same key are still served, so the key
    // must neither be retired nor reported as a broken read.
    const REFUSED_BODY = {
      error: {
        message: 'DeepAI models are temporarily unavailable. Try again later.',
        type: 'check_in_refused',
        code: 'check_in_refused',
      },
    }

    test('reads as an unknown balance, not a failure and not a zero', async () => {
      const adapter = createDeepaiUsageAdapter({ fetch: (async () =>
        new Response(JSON.stringify(REFUSED_BODY), { status: 403 })) as unknown as typeof fetch })
      const result = await adapter.read({ baseUrl: BASE_URL, allowInsecureHttp: false, upstreamKey: KEY })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.readings).toHaveLength(1)
      expect(result.readings[0]).toMatchObject({
        unit: 'Theos',
        balance: null,
        limit: null,
        remainingPercent: null,
        resetAt: null,
        confidence: 'unknown',
        diagnostics: { upstreamCode: 'check_in_refused' },
      })
    })

    test('leaves the key the health it had', async () => {
      const adapter = createDeepaiUsageAdapter({ fetch: (async () =>
        new Response(JSON.stringify(REFUSED_BODY), { status: 403 })) as unknown as typeof fetch })
      const result = await adapter.read({ baseUrl: BASE_URL, allowInsecureHttp: false, upstreamKey: KEY })
      if (!result.ok) throw new Error('expected a reading')
      const now = new Date('2026-11-17T12:00:00.000Z')
      const evidence = result.readings.map((reading) => deepaiCapacityEvidenceOf(reading, 'key-1', now))
      expect(evidence[0]).toMatchObject({ availability: 'unknown', authority: 'unknown' })

      for (const existing of [
        { health: 'active', reason: 'authoritative inference success', retryAfterAt: null },
        { health: 'exhausted', reason: 'credit exhausted', retryAfterAt: new Date('2026-11-17T13:00:00.000Z') },
      ] as const) {
        const decision = reconcileCapacity({
          ownerEnabled: true,
          keyId: 'key-1',
          accountId: null,
          model: null,
          existing: { ...existing, scope: 'key', scopeId: 'key-1', model: null },
          credentialEvidence: null,
          capacityEvidence: evidence,
          now,
        })
        expect(decision.health).toBe(existing.health)
      }
    })
  })

  test('an unreachable gateway is reported as unreachable', async () => {
    const adapter = createDeepaiUsageAdapter({ fetch: (async () => {
      throw new Error('connection refused')
    }) as unknown as typeof fetch })
    const result = await adapter.read({ baseUrl: BASE_URL, allowInsecureHttp: false, upstreamKey: KEY })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toEqual({
      code: 'upstream_unreachable',
      message: 'DeepAI entitlement endpoint could not be reached',
    })
  })

  test('an unparseable body is a parse failure', async () => {
    const adapter = createDeepaiUsageAdapter({ fetch: (async () =>
      new Response('<html>not json</html>', { status: 200 })) as unknown as typeof fetch })
    const result = await adapter.read({ baseUrl: BASE_URL, allowInsecureHttp: false, upstreamKey: KEY })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toEqual({
      code: 'unparseable_response',
      message: 'DeepAI entitlement endpoint returned an unparseable body',
    })
  })

  test('a cancelled poll stops before it reaches the gateway', async () => {
    let called = false
    const adapter = createDeepaiUsageAdapter({ fetch: (async () => {
      called = true
      return new Response(JSON.stringify(HEALTHY_BODY), { status: 200 })
    }) as unknown as typeof fetch })
    const controller = new AbortController()
    controller.abort()
    const result = await adapter.read({
      baseUrl: BASE_URL,
      allowInsecureHttp: false,
      upstreamKey: KEY,
      signal: controller.signal,
    })
    expect(called).toBe(false)
    expect(result.ok).toBe(false)
  })
})
