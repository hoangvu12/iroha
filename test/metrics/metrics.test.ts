import { describe, expect, test } from 'bun:test'
import { ALL_KEY_HEALTH_STATES, MetricsCollector } from '../../src/metrics/metrics.ts'

describe('metrics collector', () => {
  test('records bounded request and retry counters without identifiers', () => {
    let now = 0
    const collector = new MetricsCollector({ now: () => now })
    const first = new Request('http://iroha.test/providers/one/v1/chat/completions')
    const second = new Request('http://iroha.test/providers/two/v1/chat/completions')

    collector.begin(first)
    now = 125
    collector.finish(first, 200)
    collector.recordRetry()
    collector.begin(second)
    now = 500
    collector.finish(second, 503)

    const text = collector.render({
      unverified: 0,
      active: 1,
      cooling_down: 0,
      invalid_authentication: 0,
      exhausted: 0,
      disabled: 0,
    })

    expect(text).toContain('iroha_requests_total{outcome="success"} 1')
    expect(text).toContain('iroha_requests_total{outcome="failure"} 1')
    expect(text).toContain('iroha_request_failures_total{kind="http_5xx"} 1')
    expect(text).toContain('iroha_retries_total 1')
    expect(text).toContain('iroha_request_duration_seconds_bucket{le="+Inf"} 2')
    expect(ALL_KEY_HEALTH_STATES).toEqual([
      'unverified',
      'active',
      'cooling_down',
      'invalid_authentication',
      'exhausted',
      'disabled',
    ])
    expect(text).not.toContain('/providers/one')
    expect(text).not.toContain('/providers/two')
  })
})
