import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  createMinimaxUsageAdapter,
  minimaxCapacityEvidenceOf,
} from '../../src/usage/minimax-usage-adapter.ts'
import creditNegative from '../fixtures/minimax/credit-negative.json'
import subscriptionMalformed from '../fixtures/minimax/subscription-malformed.json'
import subscriptionUndocumentedStatus from '../fixtures/minimax/subscription-undocumented-status.json'

const UPSTREAM_KEY = 'sk-upstream-secret-value-for-tests'

interface RecordedCall {
  readonly url: string
  readonly init: RequestInit | undefined
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('the MiniMax Usage Adapter', () => {
  let recorded: RecordedCall[]
  let fetchImpl: typeof fetch

  beforeEach(() => {
    recorded = []
    fetchImpl = (async (input: Request | string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      recorded.push({ url, init })
      throw new Error('unhandled mock fetch call: ' + url)
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    recorded = []
  })

  function route(
    subscription: (call: RecordedCall) => Response,
    credit: (call: RecordedCall) => Response = () =>
      jsonResponse(
        { available_amount: '0.00', base_resp: { status_code: 0, status_msg: 'success' } },
        { status: 200 },
      ),
  ) {
    fetchImpl = (async (input: Request | string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const call: RecordedCall = { url, init }
      recorded.push(call)
      if (url.endsWith('/v1/api/openplatform/coding_plan/remains')) {
        return subscription(call)
      }
      if (url.endsWith('/account/query_balance')) {
        return credit(call)
      }
      throw new Error('unexpected URL: ' + url)
    }) as unknown as typeof fetch
  }

  test('visibility is authoritative', () => {
    expect(createMinimaxUsageAdapter().visibility).toBe('authoritative')
  })

  test('reports the subscription reading on a successful coding-plan response', async () => {
    route((call) =>
      jsonResponse({
        model_remains: [
          {
            model_name: 'general',
            current_interval_total_count: 1000,
            current_interval_remaining_percent: 62,
            remains_time: 3_600_000,
            end_time: 1_900_000_000_000,
            current_subscribe: { current_subscribe_end_time: 1_900_000_000 },
          },
        ],
        base_resp: { status_code: 0, status_msg: 'success' },
      }),
    )

    const adapter = createMinimaxUsageAdapter({ fetch: fetchImpl })
    const result = await adapter.read({
      baseUrl: 'https://api.minimax.io/v1',
      allowInsecureHttp: false,
      upstreamKey: UPSTREAM_KEY,
      signal: null,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.readings).toHaveLength(1)
    const reading = result.readings[0] as NonNullable<typeof result.readings[number]>
    expect(reading.unit).toBe('requests')
    expect(reading.remainingPercent).toBe(62)
    expect(reading.plan).toBe('general')
    expect(reading.balance).toBeNull()
    expect(reading.used).toBeNull()
    expect(reading.limit).toBeNull()
    expect(reading.scope).toEqual({ kind: 'connection_model', model: 'general' })
    expect(reading.resetAt).toEqual(new Date(1_900_000_000_000))
    expect(reading.confidence).toBe('confirmed')
    expect(reading.diagnostics).toMatchObject({ source: 'minimax-usage-adapter', kind: 'subscription' })
  })

  test('uses reported percentages when MiniMax redacts plan counts as zero', async () => {
    route(() =>
      jsonResponse({
        model_remains: [
          {
            model_name: 'general',
            current_interval_total_count: 0,
            current_interval_usage_count: 0,
            current_interval_remaining_percent: 85,
            current_interval_status: 1,
            current_weekly_total_count: 0,
            current_weekly_usage_count: 0,
            current_weekly_remaining_percent: 100,
            current_weekly_status: 3,
            end_time: 1_900_000_000_000,
          },
        ],
        base_resp: { status_code: 0, status_msg: 'success' },
      }),
    )

    const result = await createMinimaxUsageAdapter({ fetch: fetchImpl }).read({
      baseUrl: 'https://api.minimax.io/v1',
      allowInsecureHttp: false,
      upstreamKey: UPSTREAM_KEY,
      signal: null,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.readings).toHaveLength(1)
    expect(result.readings[0]?.remainingPercent).toBe(85)
    expect(result.readings[0]?.limit).toBeNull()
    expect(result.readings[0]?.used).toBeNull()
  })

  test('uses the weekly percentage when the weekly Token Plan limit is lower', async () => {
    route(() => jsonResponse({
      model_remains: [{
        model_name: 'general',
        current_interval_remaining_percent: 17,
        current_interval_status: 1,
        current_weekly_remaining_percent: 0,
        current_weekly_status: 2,
        end_time: 1_900_000_000_000,
        weekly_end_time: 1_910_000_000_000,
      }],
      base_resp: { status_code: 0, status_msg: 'success' },
    }))

    const result = await createMinimaxUsageAdapter({ fetch: fetchImpl }).read({
      baseUrl: 'https://api.minimax.io/v1',
      allowInsecureHttp: false,
      upstreamKey: UPSTREAM_KEY,
      signal: null,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.readings[0]?.remainingPercent).toBe(0)
    expect(result.readings[0]?.resetAt).toEqual(new Date(1_910_000_000_000))
  })

  test('uses percentages rather than undocumented status numbers to find the limiting window', async () => {
    route(() => jsonResponse(subscriptionUndocumentedStatus))

    const result = await createMinimaxUsageAdapter({ fetch: fetchImpl }).read({
      baseUrl: 'https://api.minimax.io/v1',
      allowInsecureHttp: false,
      upstreamKey: UPSTREAM_KEY,
      signal: null,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.readings[0]?.remainingPercent).toBe(0)
    expect(result.readings[0]?.resetAt).toEqual(new Date(1_910_000_000_000))
    expect(result.readings[0]?.diagnostics).toMatchObject({
      intervalStatus: 9876,
      weeklyStatus: 3,
      limitingWindow: 'weekly',
    })
  })

  test('normalizes negative credit without collapsing it to unavailable evidence', async () => {
    route(
      () => jsonResponse({ model_remains: null, base_resp: { status_code: 2062 } }),
      () => jsonResponse(creditNegative),
    )

    const result = await createMinimaxUsageAdapter({ fetch: fetchImpl }).read({
      baseUrl: 'https://api.minimax.io/v1',
      allowInsecureHttp: false,
      upstreamKey: UPSTREAM_KEY,
      signal: null,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.readings[0]?.balance).toBe(-1.25)
  })

  test('maps non-positive credit to authoritative key-scoped exhaustion', () => {
    const observedAt = new Date('2026-08-16T05:00:00.000Z')
    const evidence = minimaxCapacityEvidenceOf({
      unit: 'cny', balance: -1.25, used: null, limit: null,
      remainingPercent: null, plan: null, resetAt: null,
      scope: { kind: 'provider' }, keyId: null, confidence: 'confirmed',
      diagnostics: { source: 'minimax-usage-adapter', kind: 'credit' },
    }, 'key-credit', observedAt)

    expect(evidence).toEqual({
      availability: 'exhausted', authority: 'authoritative',
      scope: { kind: 'key', keyId: 'key-credit' }, reason: 'credit_exhausted',
      observedAt, freshUntil: new Date('2026-08-16T05:01:00.000Z'), recheckAt: null,
      facts: { remaining: -1.25, unit: 'cny' },
      diagnostics: {
        classification: 'credit_exhausted', capacityScope: 'key', remaining: -1.25,
      },
    })
  })

  test('maps the limiting subscription percentage and timestamp without interpreting status numbers', () => {
    const observedAt = new Date('2026-08-16T05:00:00.000Z')
    const evidence = minimaxCapacityEvidenceOf({
      unit: 'requests', balance: null, used: null, limit: null,
      remainingPercent: 0, plan: 'general', resetAt: new Date('2026-08-16T06:00:00.000Z'),
      scope: { kind: 'connection_model', model: 'general' }, keyId: null,
      confidence: 'confirmed',
      diagnostics: { kind: 'subscription', intervalStatus: 9876, weeklyStatus: 3, limitingWindow: 'weekly' },
    }, 'key-plan', observedAt)

    expect(evidence.availability).toBe('exhausted')
    expect(evidence.reason).toBe('window_exhausted')
    expect(evidence.scope).toEqual({ kind: 'key', keyId: 'key-plan' })
    expect(evidence.recheckAt).toEqual(new Date('2026-08-16T06:00:00.000Z'))
    expect(evidence.facts).toEqual({ remainingPercent: 0, unit: 'requests' })
    expect(evidence.diagnostics).toEqual({
      providerCode: '3', classification: 'window_exhausted', capacityScope: 'key',
      limitingWindow: 'weekly', recheckAt: '2026-08-16T06:00:00.000Z', remainingPercent: 0,
    })
  })

  test('maps fresh positive entitlement to authoritative availability', () => {
    const observedAt = new Date('2026-08-16T05:00:00.000Z')
    const evidence = minimaxCapacityEvidenceOf({
      unit: 'requests', balance: null, used: null, limit: null,
      remainingPercent: 41, plan: 'general', resetAt: null,
      scope: { kind: 'connection_model', model: 'general' }, keyId: null,
      confidence: 'confirmed', diagnostics: { kind: 'subscription', limitingWindow: 'five_hour' },
    }, 'key-positive', observedAt)
    expect(evidence.availability).toBe('available')
    expect(evidence.reason).toBe('positive_entitlement')
  })

  test('falls through to credit when the subscription percentages are malformed', async () => {
    route(
      () => jsonResponse(subscriptionMalformed),
      () => jsonResponse({ available_amount: '8.50', base_resp: { status_code: 0 } }),
    )

    const result = await createMinimaxUsageAdapter({ fetch: fetchImpl }).read({
      baseUrl: 'https://api.minimax.io/v1',
      allowInsecureHttp: false,
      upstreamKey: UPSTREAM_KEY,
      signal: null,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.readings[0]?.unit).toBe('cny')
    expect(result.readings[0]?.balance).toBe(8.5)
  })

  test('falls through to credit on a 2062 no-active-subscription response', async () => {
    route(
      () =>
        jsonResponse(
          {
            model_remains: null,
            base_resp: { status_code: 2062, status_msg: 'no active token plan subscription' },
          },
          { status: 200 },
        ),
      () =>
        jsonResponse(
          {
            available_amount: '17.15',
            cash_balance: '17.15',
            voucher_balance: '0.00',
            base_resp: { status_code: 0, status_msg: 'success' },
          },
          { status: 200 },
        ),
    )

    const adapter = createMinimaxUsageAdapter({ fetch: fetchImpl })
    const result = await adapter.read({
      baseUrl: 'https://api.minimax.io/v1',
      allowInsecureHttp: false,
      upstreamKey: UPSTREAM_KEY,
      signal: null,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.readings).toHaveLength(1)
    const reading = result.readings[0] as NonNullable<typeof result.readings[number]>
    expect(reading.unit).toBe('cny')
    expect(reading.balance).toBe(17.15)
    expect(reading.used).toBeNull()
    expect(reading.limit).toBeNull()
    expect(reading.remainingPercent).toBeNull()
    expect(reading.plan).toBeNull()
    expect(reading.scope).toEqual({ kind: 'provider' })
    expect(reading.diagnostics).toMatchObject({ source: 'minimax-usage-adapter', kind: 'credit' })

    expect(recorded.length).toBe(2)
    expect(recorded[0]?.url).toContain('/v1/api/openplatform/coding_plan/remains')
    expect(recorded[1]?.url).toContain('/account/query_balance')
  })

  test('routes the .com mainland region with its referer', async () => {
    route(
      (call) => {
        const init = call.init
        const headers = (init?.headers ?? {}) as Record<string, string>
        expect(headers['referer']).toBe('https://platform.minimaxi.com/')
        return jsonResponse({
          model_remains: [
            {
              model_name: 'general',
              current_interval_total_count: 500,
              current_interval_remaining_percent: 80,
              remains_time: 60_000,
            },
          ],
          base_resp: { status_code: 0, status_msg: 'success' },
        })
      },
    )

    const adapter = createMinimaxUsageAdapter({ fetch: fetchImpl })
    await adapter.read({
      baseUrl: 'https://api.minimaxi.com/v1',
      allowInsecureHttp: false,
      upstreamKey: UPSTREAM_KEY,
      signal: null,
    })

    expect(recorded[0]?.url.startsWith('https://www.minimaxi.com/')).toBe(true)
  })

  test('routes the .chat region with its referer', async () => {
    route(
      (call) => {
        const init = call.init
        const headers = (init?.headers ?? {}) as Record<string, string>
        expect(headers['referer']).toBe('https://platform.minimax.io/')
        return jsonResponse({
          model_remains: [
            {
              model_name: 'general',
              current_interval_total_count: 100,
              current_interval_remaining_percent: 100,
              remains_time: 3_600_000,
            },
          ],
          base_resp: { status_code: 0, status_msg: 'success' },
        })
      },
    )

    const adapter = createMinimaxUsageAdapter({ fetch: fetchImpl })
    await adapter.read({
      baseUrl: 'https://api.minimax.chat/v1',
      allowInsecureHttp: false,
      upstreamKey: UPSTREAM_KEY,
      signal: null,
    })

    expect(recorded[0]?.url.startsWith('https://api.minimax.chat/')).toBe(true)
  })

  test('sends the bearer authorization on every call', async () => {
    route(
      (call) => {
        const headers = (call.init?.headers ?? {}) as Record<string, string>
        expect(headers['authorization']).toBe(`Bearer ${UPSTREAM_KEY}`)
        return jsonResponse({
          model_remains: [],
          base_resp: { status_code: 0, status_msg: 'success' },
        })
      },
    )

    const adapter = createMinimaxUsageAdapter({ fetch: fetchImpl })
    await adapter.read({
      baseUrl: 'https://api.minimax.io/v1',
      allowInsecureHttp: false,
      upstreamKey: UPSTREAM_KEY,
      signal: null,
    })
  })

  test('reports upstream_refused when both endpoints return non-2xx', async () => {
    route(
      () => new Response('forbidden', { status: 403 }),
      () => new Response('forbidden', { status: 403 }),
    )

    const adapter = createMinimaxUsageAdapter({ fetch: fetchImpl })
    const result = await adapter.read({
      baseUrl: 'https://api.minimax.io/v1',
      allowInsecureHttp: false,
      upstreamKey: UPSTREAM_KEY,
      signal: null,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('upstream_refused')
    if (result.failure.code === 'upstream_refused') {
      expect(result.failure.status).toBe(403)
    }
  })

  test('reports upstream_unreachable when the subscription endpoint throws', async () => {
    fetchImpl = (async () => {
      throw new TypeError('connect ECONNREFUSED')
    }) as unknown as typeof fetch

    const adapter = createMinimaxUsageAdapter({ fetch: fetchImpl })
    const result = await adapter.read({
      baseUrl: 'https://api.minimax.io/v1',
      allowInsecureHttp: false,
      upstreamKey: UPSTREAM_KEY,
      signal: null,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('upstream_unreachable')
  })

  test('reports unparseable_response when credit body is not parseable', async () => {
    route(
      () =>
        jsonResponse(
          { model_remains: null, base_resp: { status_code: 2062 } },
          { status: 200 },
        ),
      () => new Response('not-json', { status: 200 }),
    )

    const adapter = createMinimaxUsageAdapter({ fetch: fetchImpl })
    const result = await adapter.read({
      baseUrl: 'https://api.minimax.io/v1',
      allowInsecureHttp: false,
      upstreamKey: UPSTREAM_KEY,
      signal: null,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('unparseable_response')
  })

  test('returns a cancelled failure when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const adapter = createMinimaxUsageAdapter({ fetch: fetchImpl })
    const result = await adapter.read({
      baseUrl: 'https://api.minimax.io/v1',
      allowInsecureHttp: false,
      upstreamKey: UPSTREAM_KEY,
      signal: controller.signal,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('upstream_unreachable')
  })

  test('falls back to the .io region for an unrecognised but minimax-shaped base URL', async () => {
    route(
      (call) => {
        expect(call.url.startsWith('https://api.minimax.io/')).toBe(true)
        return jsonResponse({
          model_remains: [
            {
              model_name: 'general',
              current_interval_total_count: 200,
              current_interval_remaining_percent: 50,
              remains_time: 1000,
            },
          ],
          base_resp: { status_code: 0, status_msg: 'success' },
        })
      },
    )

    const adapter = createMinimaxUsageAdapter({ fetch: fetchImpl })
    await adapter.read({
      baseUrl: 'https://eu.minimax.io/v1',
      allowInsecureHttp: false,
      upstreamKey: UPSTREAM_KEY,
      signal: null,
    })
  })

  test('emits one reading per coding-plan tier when model_remains has multiple entries', async () => {
    route(() =>
      jsonResponse({
        model_remains: [
          {
            model_name: 'general',
            current_interval_total_count: 200,
            current_interval_remaining_percent: 80,
            remains_time: 1_000_000,
          },
          {
            model_name: 'video',
            current_interval_total_count: 500,
            current_interval_remaining_percent: 25,
            remains_time: 2_000_000,
          },
        ],
        base_resp: { status_code: 0, status_msg: 'success' },
      }),
    )

    const adapter = createMinimaxUsageAdapter({ fetch: fetchImpl })
    const result = await adapter.read({
      baseUrl: 'https://api.minimax.io/v1',
      allowInsecureHttp: false,
      upstreamKey: UPSTREAM_KEY,
      signal: null,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Only the "general" tier is in scope; "video" is filtered out so the
    // cell answers "how much coding capacity is left?" with one number.
    expect(result.readings).toHaveLength(1)
    const reading = result.readings[0] as NonNullable<typeof result.readings[number]>
    expect(reading.plan).toBe('general')
    expect(reading.remainingPercent).toBe(80)
    expect(reading.scope).toEqual({ kind: 'connection_model', model: 'general' })

    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.url).toContain('/v1/api/openplatform/coding_plan/remains')
  })

  test('falls through to credit when no general tier is present', async () => {
    route(
      () =>
        jsonResponse(
          {
            model_remains: [
              { model_name: 'video', current_interval_remaining_percent: 50 },
              { model_name: 'audio', current_interval_remaining_percent: 90 },
            ],
            base_resp: { status_code: 0, status_msg: 'success' },
          },
          { status: 200 },
        ),
      () =>
        jsonResponse(
          {
            available_amount: '7.50',
            base_resp: { status_code: 0, status_msg: 'success' },
          },
          { status: 200 },
        ),
    )

    const adapter = createMinimaxUsageAdapter({ fetch: fetchImpl })
    const result = await adapter.read({
      baseUrl: 'https://api.minimax.io/v1',
      allowInsecureHttp: false,
      upstreamKey: UPSTREAM_KEY,
      signal: null,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.readings).toHaveLength(1)
    const credit = result.readings[0] as NonNullable<typeof result.readings[number]>
    expect(credit.unit).toBe('cny')
    expect(credit.balance).toBe(7.5)
    expect(credit.scope).toEqual({ kind: 'provider' })

    expect(recorded).toHaveLength(2)
  })

  test('uses end_time for resetAt when the upstream provides it', async () => {
    route(() =>
      jsonResponse({
        model_remains: [
          {
            model_name: 'general',
            current_interval_remaining_percent: 80,
            remains_time: 60_000,
            end_time: 1_900_000_000_000,
          },
        ],
        base_resp: { status_code: 0, status_msg: 'success' },
      }),
    )

    const adapter = createMinimaxUsageAdapter({ fetch: fetchImpl })
    const result = await adapter.read({
      baseUrl: 'https://api.minimax.io/v1',
      allowInsecureHttp: false,
      upstreamKey: UPSTREAM_KEY,
      signal: null,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.readings[0]?.resetAt).toEqual(new Date(1_900_000_000_000))
  })
})
