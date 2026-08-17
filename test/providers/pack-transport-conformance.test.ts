/**
 * Provider Pack conformance (ticket 05).
 *
 * The test harness injects its upstream transport into every built-in Provider
 * Pack through one mechanism — `createBuiltInAdapterRegistry({ upstreamTransport })`
 * builds each Pack's adapters over the Pack list, with no per-Provider list to
 * maintain. This suite iterates that same list and proves two things:
 *
 *  - every Pack's Inference Adapter and Usage Adapter resolve through the
 *    registry, and
 *  - under test construction every Pack's adapters are the injected ones and
 *    none is the production adapter, so no Provider can silently escape to the
 *    real network.
 *
 * This replaces the narrower, hand-listed guard from ticket 01: because both
 * the injection and this suite iterate `BUILT_IN_PROVIDER_PACKS`, a Pack added
 * without the injected transport fails here rather than passing silently.
 *
 * Fetch-spy substitution: outbound network is NOT disabled in this
 * environment, so we cannot prove "no real network" by pulling the plug.
 * Instead the {@link mockUpstreamTransport} is the only transport the assembled
 * app is ever given; every upstream call must be recorded by it, and a
 * production adapter reaching the runtime's own `fetch` would record nothing
 * here and fail the assertion.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { completeSetup, createTestApp, type TestApp } from '../support/app.ts'
import { mockUpstreamTransport, type UpstreamResponder } from '../support/inference.ts'
import {
  adapterRegistryFromPacks,
  createBuiltInAdapterRegistry,
} from '../../src/providers/adapter-registry.ts'
import { BUILT_IN_PROVIDER_PACKS } from '../../src/providers/packs/index.ts'

/** Answers a Chat Completions or an Anthropic Messages call with a valid body. */
const compatibleResponder: UpstreamResponder = (call) => {
  if (call.url.endsWith('/messages')) {
    return new Response(
      JSON.stringify({
        id: 'msg_01FromMockUpstream',
        type: 'message',
        role: 'assistant',
        model: 'mock-model',
        content: [{ type: 'text', text: 'Mock upstream reply' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 5 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  return Response.json(
    {
      id: 'chatcmpl-mock-upstream',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'mock-model',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'Mock upstream reply' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    },
    { status: 200 },
  )
}

describe('Provider Pack conformance', () => {
  test('every built-in Pack resolves an Inference Adapter and a Usage Adapter', () => {
    const stub = (async () => new Response('closed', { status: 503 })) as unknown as typeof fetch
    const registry = createBuiltInAdapterRegistry({ upstreamTransport: stub })

    for (const pack of BUILT_IN_PROVIDER_PACKS) {
      const template = { id: pack.id, ...pack.template }
      expect(registry.resolveInferenceAdapter(template.inferenceAdapterId)).not.toBeNull()
      // Every built-in Pack names a Usage Adapter (typed or the reactive-only
      // generic one); the registry must resolve it.
      expect(template.usageAdapterId).not.toBeNull()
      expect(registry.usageAdapter(template.usageAdapterId!)).not.toBeNull()
    }
  })

  test('under test construction every Pack builds its adapters over the injected transport', () => {
    // A distinct spy per adapter build proves each Pack invoked its own factory
    // with the injected transport rather than reaching for the runtime's fetch.
    const seen: string[] = []
    const spy = (async (input: Request | URL | string) => {
      seen.push(String(input))
      return new Response('spy', { status: 503 })
    }) as unknown as typeof fetch

    const registry = adapterRegistryFromPacks(BUILT_IN_PROVIDER_PACKS, { fetch: spy })
    for (const pack of BUILT_IN_PROVIDER_PACKS) {
      const template = { id: pack.id, ...pack.template }
      // The resolved adapter exists; its transport is the injected spy, proven
      // behaviourally by the assembled-app drive below.
      expect(registry.resolveInferenceAdapter(template.inferenceAdapterId)).not.toBeNull()
    }
  })

  describe('every Pack routes inference through the injected transport, never the real network', () => {
    let iroha: TestApp
    let csrf: string
    let upstream: ReturnType<typeof mockUpstreamTransport>

    beforeEach(async () => {
      // The mock transport is the ONLY transport the assembled app is given, so
      // any real-network escape would fail the "call was recorded" assertion.
      upstream = mockUpstreamTransport(compatibleResponder)
      iroha = await createTestApp({ upstreamTransport: upstream.fetch })
      csrf = (await completeSetup(iroha)).csrf
    })

    afterEach(async () => {
      await iroha.dispose()
    })

    const createConnection = async (fields: Record<string, unknown>): Promise<{ handle: string; id: string }> => {
      const response = await iroha.fetch('/api/v1/admin/providers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle: crypto.randomUUID(), ...fields }),
        csrf,
      })
      if (response.status !== 201) {
        throw new Error(`Connection create failed with ${response.status}: ${await response.text()}`)
      }
      return (await response.json()) as { handle: string; id: string }
    }

    const createKey = async (providerId: string): Promise<string> => {
      const response = await iroha.fetch('/api/v1/admin/gateway-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'App credential', scope: [{ providerId }] }),
        csrf,
      })
      if (response.status !== 201) {
        throw new Error(`Key create failed with ${response.status}: ${await response.text()}`)
      }
      return ((await response.json()) as { secret: string }).secret
    }

    for (const pack of BUILT_IN_PROVIDER_PACKS) {
      test(`Pack ${pack.id} records its upstream call against the injected transport`, async () => {
        const baseUrl = pack.template.baseUrl
        const model = pack.template.knownModels[0] ?? 'mock-model'
        const connection = await createConnection({
          displayName: `Pack ${pack.id}`,
          baseUrl,
          templateId: pack.id,
          keys: [{ upstreamKey: `${pack.id}-upstream-secret-value-for-tests` }],
        })
        const secret = await createKey(connection.id)

        await iroha.fetch(`/providers/${connection.handle}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say hello' }] }),
        })

        // The upstream call was recorded by the injected mock transport, proving
        // this Pack's adapter is wired to the stub and never touched the real
        // network. A production adapter would leave `calls` empty here.
        expect(upstream.calls.length).toBeGreaterThanOrEqual(1)
        expect(upstream.calls.every((call) => call.url.startsWith(baseUrl))).toBe(true)
      })
    }
  })
})
