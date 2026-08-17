import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createSecretCipher } from '../../src/crypto/index.ts'
import type {
  KeyProbeRequest,
  KeyProbeResult,
  UpstreamKeyProbe,
} from '../../src/providers/index.ts'
import { completeSetup, createTestApp, TEST_MASTER_KEY, type TestApp } from '../support/app.ts'

const BASE = '/api/v1/admin/providers'
const BASE_URL = 'https://api.example.com/v1'
const KEY_BASE_URL = 'https://key.example.com/v1'
const SECOND_KEY_BASE_URL = 'https://other-key.example.com/v1'

/**
 * The pool width `#probeConnectionKeys` promises. The tests assert against this
 * number rather than "some parallelism": unbounded probing is as wrong as
 * sequential probing, because forty simultaneous authentication attempts on one
 * upstream earn a 429 that would be recorded as forty rate-limited keys.
 */
const POOL_SIZE = 5

/** Comfortably more keys than the pool, so the pool has to recycle workers. */
const KEY_COUNT = 12

interface KeyBody {
  id: string
  health:
    | 'unverified'
    | 'active'
    | 'cooling_down'
    | 'invalid_authentication'
    | 'exhausted'
    | 'disabled'
  baseUrl: string | null
  effectiveBaseUrl: string
  lastProbe: { at: string; verdict: string; reason: string | null } | null
}

interface ProviderBody {
  id: string
  handle: string
  keys: KeyBody[]
}

interface WatchedProbe extends UpstreamKeyProbe {
  /** Every request the probe was asked, in completion-independent order. */
  readonly calls: readonly KeyProbeRequest[]
  /** The largest number of tests this probe ever had in flight at once. */
  readonly maxInFlight: number
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * A probe that reports how many of its tests overlapped.
 *
 * Each test is held until `releaseAt` of them are in flight together, so a pool
 * of that width saturates and then releases without anyone waiting on the wall
 * clock. `HOLD_LIMIT_MS` releases whatever is still held, so a pool that is
 * *narrower* than expected fails the assertion instead of hanging the suite.
 */
function watchedProbe(
  options: {
    readonly releaseAt?: number
    readonly delayMs?: number
    readonly answer?: (request: KeyProbeRequest) => KeyProbeResult
  } = {},
): WatchedProbe {
  const HOLD_LIMIT_MS = 100
  const calls: KeyProbeRequest[] = []
  let inFlight = 0
  let widest = 0
  let release: () => void = () => undefined
  const saturated = new Promise<void>((resolve) => {
    release = resolve
  })

  return {
    calls,
    get maxInFlight() {
      return widest
    },
    async test(request: KeyProbeRequest): Promise<KeyProbeResult> {
      calls.push(request)
      inFlight += 1
      widest = Math.max(widest, inFlight)
      try {
        if (options.releaseAt !== undefined) {
          if (inFlight >= options.releaseAt) release()
          await Promise.race([saturated, delay(HOLD_LIMIT_MS)])
        }
        if (options.delayMs !== undefined) await delay(options.delayMs)
        return options.answer?.(request) ?? { verdict: 'authenticated', reason: null }
      } finally {
        inFlight -= 1
      }
    },
  }
}

describe('probing Upstream Keys through a bounded pool', () => {
  let iroha: TestApp
  let probe: WatchedProbe
  let csrf: string
  let handleSequence = 0

  const start = async (watched: WatchedProbe): Promise<void> => {
    probe = watched
    iroha = await createTestApp({ upstreamKeyProbe: watched })
    csrf = (await completeSetup(iroha)).csrf
  }

  beforeEach(() => {
    handleSequence = 0
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  const createProvider = async (
    keys: readonly { upstreamKey: string; baseUrl?: string }[],
  ): Promise<ProviderBody> => {
    handleSequence += 1
    const response = await iroha.fetch(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Example',
        handle: `example-${handleSequence}`,
        baseUrl: BASE_URL,
        keys,
      }),
      csrf,
    })
    if (response.status !== 201) {
      throw new Error(`Create failed with ${response.status}: ${await response.text()}`)
    }
    return (await response.json()) as ProviderBody
  }

  const view = async (providerId: string): Promise<ProviderBody> =>
    (await (await iroha.fetch(`${BASE}/${providerId}`)).json()) as ProviderBody

  const keySet = (count: number): { upstreamKey: string }[] =>
    Array.from({ length: count }, (_, index) => ({ upstreamKey: `sk-pooled-key-${index}` }))

  /**
   * Leaves `count` Unverified Keys on a Provider without probing them, which is
   * the state the sequential loop used to pay for: the next mutation that adds a
   * Key probes every one of them before it answers.
   */
  const seedUnverifiedKeys = async (providerId: string, count: number): Promise<void> => {
    const cipher = createSecretCipher(TEST_MASTER_KEY)
    const at = new Date('2026-01-01T00:00:00.000Z')
    for (let index = 0; index < count; index += 1) {
      await iroha.database.providers.insertKey({
        id: `uk_seeded_${index}`,
        providerId,
        baseUrl: null,
        accountId: null,
        encryptedKey: await cipher.encrypt(`sk-seeded-key-${index}`),
        health: 'unverified',
        lastProbeAt: null,
        lastProbeVerdict: null,
        lastProbeReason: null,
        healthReason: null,
        healthChangedAt: at,
        retryAfterAt: null,
        healthScope: 'key',
        healthScopeId: null,
        healthModel: null,
        allowedModels: null,
        deniedModels: null,
        createdAt: at,
        updatedAt: at,
      })
    }
  }

  test('probes every Unverified Key exactly once, even past the pool width', async () => {
    await start(watchedProbe({ releaseAt: POOL_SIZE }))

    const created = await createProvider(keySet(KEY_COUNT))

    expect(created.keys).toHaveLength(KEY_COUNT)
    expect(probe.calls).toHaveLength(KEY_COUNT)
    // Exactly once each: no key probed twice, none skipped.
    expect(new Set(probe.calls.map((call) => call.upstreamKey)).size).toBe(KEY_COUNT)

    const current = await view(created.id)
    expect(current.keys.filter((key) => key.lastProbe === null)).toEqual([])
    expect(current.keys.every((key) => key.health === 'active')).toBe(true)
  })

  test('keeps at most five probes in flight at once', async () => {
    await start(watchedProbe({ releaseAt: POOL_SIZE }))

    await createProvider(keySet(KEY_COUNT))

    // The bound is the point: twelve keys must not become twelve simultaneous
    // authentication attempts on one upstream.
    expect(probe.maxInFlight).toBeLessThanOrEqual(POOL_SIZE)
    // And the pool is genuinely concurrent, not a sequential loop in disguise.
    expect(probe.maxInFlight).toBeGreaterThan(1)
  })

  test('probes each Key against its own effective base URL', async () => {
    await start(watchedProbe({ releaseAt: 2 }))

    const created = await createProvider([
      { upstreamKey: 'sk-inherits-1' },
      { upstreamKey: 'sk-override-1', baseUrl: KEY_BASE_URL },
      { upstreamKey: 'sk-inherits-2' },
      { upstreamKey: 'sk-override-2', baseUrl: SECOND_KEY_BASE_URL },
      { upstreamKey: 'sk-inherits-3' },
      { upstreamKey: 'sk-override-3', baseUrl: KEY_BASE_URL },
    ])

    // Order is undefined under the pool, so the whole set is compared at once.
    const seen = probe.calls.map((call) => ({ baseUrl: call.baseUrl, upstreamKey: call.upstreamKey }))
    expect(seen).toHaveLength(6)
    expect(seen).toEqual(
      expect.arrayContaining([
        { baseUrl: BASE_URL, upstreamKey: 'sk-inherits-1' },
        { baseUrl: BASE_URL, upstreamKey: 'sk-inherits-2' },
        { baseUrl: BASE_URL, upstreamKey: 'sk-inherits-3' },
        { baseUrl: KEY_BASE_URL, upstreamKey: 'sk-override-1' },
        { baseUrl: SECOND_KEY_BASE_URL, upstreamKey: 'sk-override-2' },
        { baseUrl: KEY_BASE_URL, upstreamKey: 'sk-override-3' },
      ]),
    )

    const current = await view(created.id)
    const overrides = current.keys.filter((key) => key.baseUrl !== null)
    expect(overrides).toHaveLength(3)
    expect(overrides.every((key) => key.effectiveBaseUrl === key.baseUrl)).toBe(true)
  })

  test('one failing probe does not stop the rest from running or recording', async () => {
    const thrower = 'sk-pooled-key-3'
    const rejected = 'sk-pooled-key-7'
    await start(
      watchedProbe({
        releaseAt: POOL_SIZE,
        answer: (request) => {
          if (request.upstreamKey === thrower) throw new Error('deliberate probe failure')
          if (request.upstreamKey === rejected) {
            return { verdict: 'rejected', reason: 'the provider rejected the key (HTTP 401)' }
          }
          return { verdict: 'authenticated', reason: null }
        },
      }),
    )

    const created = await createProvider(keySet(KEY_COUNT))

    expect(probe.calls).toHaveLength(KEY_COUNT)
    const current = await view(created.id)
    // Every key still carries a verdict, including the two unhappy ones.
    expect(current.keys.filter((key) => key.lastProbe === null)).toEqual([])
    expect(current.keys.filter((key) => key.health === 'active')).toHaveLength(KEY_COUNT - 2)
    expect(
      current.keys.filter(
        (key) =>
          key.health === 'cooling_down' && key.lastProbe?.reason === 'the key test did not complete',
      ),
    ).toHaveLength(1)
    expect(current.keys.filter((key) => key.health === 'invalid_authentication')).toHaveLength(1)
  })

  test('adding a Key to a Provider holding Unverified Keys costs a fraction of the sequential pass', async () => {
    const PROBE_COST_MS = 30
    await start(watchedProbe({ delayMs: PROBE_COST_MS }))

    const created = await createProvider([{ upstreamKey: 'sk-first-key' }])
    await seedUnverifiedKeys(created.id, KEY_COUNT - 1)
    const before = probe.calls.length

    const started = Bun.nanoseconds()
    const added = await iroha.fetch(`${BASE}/${created.id}/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upstreamKey: 'sk-added-key' }),
      csrf,
    })
    const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000

    expect(added.status).toBe(201)
    // The pass covered the seeded keys plus the new one.
    expect(probe.calls.length - before).toBe(KEY_COUNT)

    // Sequentially this pass cost KEY_COUNT round trips; through a pool of five
    // it costs ceil(KEY_COUNT / 5). The threshold sits well above the ideal so a
    // loaded machine does not fail the run, and well below the sequential cost so
    // a regression to the loop does.
    const sequentialMs = KEY_COUNT * PROBE_COST_MS
    expect(elapsedMs).toBeLessThan(sequentialMs * 0.6)

    const current = await view(created.id)
    // The Provider's own key, the seeded Unverified ones, and the new one.
    expect(current.keys).toHaveLength(KEY_COUNT + 1)
    expect(current.keys.filter((key) => key.lastProbe === null)).toEqual([])
  })
})
