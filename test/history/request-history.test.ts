import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  DEFAULT_RETENTION_DAYS,
  REQUEST_HISTORY_SETTING_KEY,
  RequestHistoryService,
} from '../../src/history/index.ts'
import type { Database } from '../../src/persistence/index.ts'
import { sqliteEngine } from '../persistence/engines.ts'

/**
 * The service-level contract for request history: the recorder handed to the
 * inference loop writes what it claims, the retention setting controls whether
 * anything is written at all, and pruning respects the configured window.
 */

describe('RequestHistoryService', () => {
  let database: Database
  let dispose: () => Promise<void>

  beforeEach(async () => {
    const opened = await sqliteEngine.open()
    database = opened.database
    dispose = opened.dispose
  })

  afterEach(async () => {
    await dispose()
  })

  const createService = (): RequestHistoryService => new RequestHistoryService({ database })

  test('records an event, its attempts, and the terminal finalize', async () => {
    const service = createService()
    await database.providers.insertProvider({
      id: 'pc_one',
      displayName: 'Example',
      baseUrl: 'https://api.example.com/v1',
      allowInsecureHttp: false,
      enabled: true,
      retryMaxAttempts: 3,
      retryAmbiguousNetwork: false,
      archivedAt: null,
      templateId: null,
      capabilities: { chat: true, streaming: true, tools: false, structuredOutput: false, responses: false },
      authHeader: 'authorization',
      authPrefix: 'Bearer ',
      staticHeadersEncrypted: '[]',
      redirectAllowSameOrigin: false,
      connectionTimeoutMs: 10_000,
      firstByteTimeoutMs: 20_000,
      nonStreamingTotalTimeoutMs: 120_000,
      streamingIdleTimeoutMs: 30_000,
      totalRetryTimeoutMs: 30_000,
      idempotencyHeader: 'Idempotency-Key',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const recorder = service.beginRequest({
      id: 'req_one',
      providerId: 'pc_one',
      model: 'gpt-4o-mini',
      gatewayKeyId: 'gk_one',
    })

    const startedAt = new Date('2026-01-01T00:00:00.000Z')
    const attempt = await recorder.startAttempt({ attemptNumber: 1, keyId: 'uk_one', at: startedAt })
    expect(await service.getEvent('req_one')).toBeNull()
    expect((await service.listEvents()).total).toBe(0)
    await attempt.finalize({
      status: 200,
      outcome: 'success',
      errorCode: null,
      retryAfterSeconds: null,
      at: new Date('2026-01-01T00:00:00.500Z'),
    })

    await recorder.finalize({
      status: 200,
      outcome: 'success',
      isStreaming: false,
      latencyMs: 500.6,
      keyId: 'uk_one',
      promptTokens: 5,
      completionTokens: 5,
      totalTokens: 10,
      errorCode: null,
    })

    const stored = await service.getEvent('req_one')
    expect(stored).not.toBeNull()
    expect(stored!.keyId).toBe('uk_one')
    expect(stored!.latencyMs).toBe(501)
    expect(stored!.promptTokens).toBe(5)
    expect(stored!.totalTokens).toBe(10)

    const attempts = await service.getAttempts('req_one')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.status).toBe(200)
    expect(attempts[0]!.outcome).toBe('success')
  })

  test('persists only bounded allow-listed Provider diagnostics on an attempt', async () => {
    const secret = 'sk-provider-secret-must-not-survive'
    const service = createService()
    await database.providers.insertProvider({
      id: 'pc_diagnostics', displayName: 'Diagnostics', baseUrl: 'https://api.example.com/v1',
      allowInsecureHttp: false, enabled: true, retryMaxAttempts: 3,
      retryAmbiguousNetwork: false, archivedAt: null, templateId: null,
      capabilities: { chat: true, streaming: true, tools: false, structuredOutput: false, responses: false },
      authHeader: 'authorization', authPrefix: 'Bearer ', staticHeadersEncrypted: '[]',
      redirectAllowSameOrigin: false, connectionTimeoutMs: 10_000, firstByteTimeoutMs: 20_000,
      nonStreamingTotalTimeoutMs: 120_000, streamingIdleTimeoutMs: 30_000,
      totalRetryTimeoutMs: 30_000, idempotencyHeader: 'Idempotency-Key',
      createdAt: new Date(), updatedAt: new Date(),
    })
    const recorder = service.beginRequest({
      id: 'req_diagnostics', providerId: 'pc_diagnostics', model: 'MiniMax-M3', gatewayKeyId: null,
    })
    const attempt = await recorder.startAttempt({ attemptNumber: 1, keyId: 'uk_one', at: new Date() })
    await attempt.finalize({
      status: 429, outcome: 'failure', errorCode: 'upstream_rate_limited', retryAfterSeconds: 12,
      diagnostics: {
        status: 429, providerCode: `limit-${'x'.repeat(100)}`, providerType: 'rate_limit',
        classification: 'capacity_limited', capacityScope: 'key', limitingWindow: 'weekly',
        retryAfterSeconds: 12, recheckAt: '2026-08-16T01:00:00.000Z', remaining: 0,
        remainingPercent: 0, used: 100, limit: 100,
        body: { prompt: secret, completion: secret }, message: secret,
        headers: { authorization: `Bearer ${secret}` }, arbitrary: secret,
      },
      at: new Date(),
    })

    const stored = (await service.getAttempts('req_diagnostics'))[0]!
    expect(stored.diagnostics).toEqual({
      status: 429, providerCode: `limit-${'x'.repeat(58)}`, providerType: 'rate_limit',
      classification: 'capacity_limited', capacityScope: 'key', limitingWindow: 'weekly',
      retryAfterSeconds: 12, recheckAt: '2026-08-16T01:00:00.000Z', remaining: 0,
      remainingPercent: 0, used: 100, limit: 100,
    })
    expect(JSON.stringify(stored)).not.toContain(secret)
  })

  test('finalizes a recovered request as successful while preserving the failed alternate trail', async () => {
    const service = createService()
    await database.providers.insertProvider({
      id: 'pc_recovered',
      displayName: 'Recovered',
      baseUrl: 'https://api.example.com/v1',
      allowInsecureHttp: false,
      enabled: true,
      retryMaxAttempts: 3,
      retryAmbiguousNetwork: false,
      archivedAt: null,
      templateId: null,
      capabilities: { chat: true, streaming: true, tools: false, structuredOutput: false, responses: false },
      authHeader: 'authorization',
      authPrefix: 'Bearer ',
      staticHeadersEncrypted: '[]',
      redirectAllowSameOrigin: false,
      connectionTimeoutMs: 10_000,
      firstByteTimeoutMs: 20_000,
      nonStreamingTotalTimeoutMs: 120_000,
      streamingIdleTimeoutMs: 30_000,
      totalRetryTimeoutMs: 30_000,
      idempotencyHeader: 'Idempotency-Key',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const recorder = service.beginRequest({
      id: 'req_recovered',
      providerId: 'pc_recovered',
      model: 'gpt-4o-mini',
      gatewayKeyId: null,
    })
    const failed = await recorder.startAttempt({ attemptNumber: 1, keyId: 'uk_exhausted', at: new Date() })
    await failed.finalize({
      status: 402,
      outcome: 'failure',
      errorCode: 'upstream_payment_required',
      retryAfterSeconds: null,
      at: new Date(),
    })
    const recovered = await recorder.startAttempt({ attemptNumber: 2, keyId: 'uk_healthy', at: new Date() })
    await recovered.finalize({
      status: 200,
      outcome: 'success',
      errorCode: null,
      retryAfterSeconds: null,
      at: new Date(),
    })
    await recorder.finalize({
      status: 200,
      outcome: 'success',
      isStreaming: false,
      latencyMs: 12,
      keyId: 'uk_healthy',
      promptTokens: 3,
      completionTokens: 4,
      totalTokens: 7,
      errorCode: null,
    })

    expect(await service.getEvent('req_recovered')).toMatchObject({
      status: 200,
      outcome: 'success',
      keyId: 'uk_healthy',
      errorCode: null,
    })
    expect((await service.getAttempts('req_recovered')).map((attempt) => ({
      attemptNumber: attempt.attemptNumber,
      status: attempt.status,
      outcome: attempt.outcome,
    }))).toEqual([
      { attemptNumber: 1, status: 402, outcome: 'failure' },
      { attemptNumber: 2, status: 200, outcome: 'success' },
    ])
  })

  test('disabled retention writes nothing', async () => {
    const service = createService()
    await service.writeRetention({ days: 0 })
    expect(await service.readRetention()).toEqual({ days: 0 })

    const recorder = service.beginRequest({
      id: 'req_off',
      providerId: 'pc_one',
      model: 'gpt-4o-mini',
      gatewayKeyId: null,
    })

    await recorder.startAttempt({ attemptNumber: 1, keyId: 'uk_one', at: new Date() })
    await recorder.finalize({
      status: 200,
      outcome: 'success',
      isStreaming: false,
      latencyMs: 0,
      keyId: 'uk_one',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      errorCode: null,
    })

    expect(await service.getEvent('req_off')).toBeNull()
  })

  test('prune removes events older than the configured window', async () => {
    const service = createService()
    await database.providers.insertProvider({
      id: 'pc_one',
      displayName: 'Example',
      baseUrl: 'https://api.example.com/v1',
      allowInsecureHttp: false,
      enabled: true,
      retryMaxAttempts: 3,
      retryAmbiguousNetwork: false,
      archivedAt: null,
      templateId: null,
      capabilities: { chat: true, streaming: true, tools: false, structuredOutput: false, responses: false },
      authHeader: 'authorization',
      authPrefix: 'Bearer ',
      staticHeadersEncrypted: '[]',
      redirectAllowSameOrigin: false,
      connectionTimeoutMs: 10_000,
      firstByteTimeoutMs: 20_000,
      nonStreamingTotalTimeoutMs: 120_000,
      streamingIdleTimeoutMs: 30_000,
      totalRetryTimeoutMs: 30_000,
      idempotencyHeader: 'Idempotency-Key',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    await service.writeRetention({ days: 30 })

    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
    const old = service.beginRequest({
      id: 'req_old',
      providerId: 'pc_one',
      model: 'gpt-4o-mini',
      gatewayKeyId: null,
    })
    await old.recordSkip('upstream_credentials_unavailable', oldDate)

    const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
    const recent = service.beginRequest({
      id: 'req_new',
      providerId: 'pc_one',
      model: 'gpt-4o-mini',
      gatewayKeyId: null,
    })
    await recent.recordSkip('upstream_credentials_unavailable', recentDate)

    const removed = await service.prune()
    expect(removed).toBe(1)
    expect((await service.listEvents()).events.map((row) => row.id)).toEqual(['req_new'])
  })

  test('recordSkip writes an event row and a single skipped attempt', async () => {
    const service = createService()
    await database.providers.insertProvider({
      id: 'pc_one',
      displayName: 'Example',
      baseUrl: 'https://api.example.com/v1',
      allowInsecureHttp: false,
      enabled: true,
      retryMaxAttempts: 3,
      retryAmbiguousNetwork: false,
      archivedAt: null,
      templateId: null,
      capabilities: { chat: true, streaming: true, tools: false, structuredOutput: false, responses: false },
      authHeader: 'authorization',
      authPrefix: 'Bearer ',
      staticHeadersEncrypted: '[]',
      redirectAllowSameOrigin: false,
      connectionTimeoutMs: 10_000,
      firstByteTimeoutMs: 20_000,
      nonStreamingTotalTimeoutMs: 120_000,
      streamingIdleTimeoutMs: 30_000,
      totalRetryTimeoutMs: 30_000,
      idempotencyHeader: 'Idempotency-Key',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const recorder = service.beginRequest({
      id: 'req_skip',
      providerId: 'pc_one',
      model: 'gpt-4o-mini',
      gatewayKeyId: 'gk_one',
    })
    await recorder.recordSkip('upstream_credentials_unavailable', new Date())

    const event = await service.getEvent('req_skip')
    expect(event).not.toBeNull()
    expect(event!.outcome).toBe('failure')
    expect(event!.errorCode).toBe('upstream_credentials_unavailable')
    expect(event!.status).toBe(503)

    const attempts = await service.getAttempts('req_skip')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.outcome).toBe('skipped')
  })

  test('default retention is 30 days', async () => {
    const service = createService()
    expect(await service.readRetention()).toEqual({ days: DEFAULT_RETENTION_DAYS })
  })

  test('lists audit events with prefix and outcome filters', async () => {
    const service = createService()
    await database.audit.record({ action: 'owner.login', outcome: 'success', at: new Date() })
    await database.audit.record({ action: 'owner.logout', outcome: 'success', at: new Date() })
    await database.audit.record({ action: 'key.tested', outcome: 'failure', at: new Date() })

    const all = await database.requestHistory.listAudit()
    expect(all.events.map((row) => row.action)).toEqual(['key.tested', 'owner.logout', 'owner.login'])

    const ownerOnly = await database.requestHistory.listAudit({ filter: { actionPrefix: 'owner.' } })
    expect(ownerOnly.events.map((row) => row.action)).toEqual(['owner.logout', 'owner.login'])

    const failures = await database.requestHistory.listAudit({ filter: { outcome: 'failure' } })
    expect(failures.events.map((row) => row.action)).toEqual(['key.tested'])
  })

  test('audit setting key matches the documented constant', () => {
    expect(REQUEST_HISTORY_SETTING_KEY).toBe('requestHistory.retention')
  })

  test('writeRetention persists and is observable on a fresh service', async () => {
    const first = createService()
    await first.writeRetention({ days: 7 })
    const second = createService()
    expect(await second.readRetention()).toEqual({ days: 7 })
  })
})
