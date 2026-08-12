import type { KeyProbeVerdict } from '../persistence/index.ts'

/**
 * The result of one low-cost test of an Upstream Key.
 *
 * Reasons are structural descriptions meant for the Owner. They never contain
 * the key, any other secret, or free upstream text, which may echo a secret.
 */
export interface KeyProbeResult {
  readonly verdict: KeyProbeVerdict
  readonly reason: string | null
}

export interface KeyProbeRequest {
  readonly baseUrl: string
  readonly upstreamKey: string
}

/**
 * Adapter-defined knowledge of how to cheaply establish whether a key can
 * authenticate against its Provider. The generic form reads the models
 * endpoint, which OpenAI-compatible providers expose without charging.
 */
export interface UpstreamKeyProbe {
  test(request: KeyProbeRequest): Promise<KeyProbeResult>
}

export interface KeyProbeOptions {
  readonly timeoutMs?: number
  /** Injectable transport; production uses the runtime's fetch. */
  readonly fetch?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * The generic OpenAI-compatible probe: `GET <base>/models` with the Upstream
 * Key sent as the bearer authentication.
 *
 * The classification is deliberately conservative. Only an explicit `401`
 * counts as a rejected key; every ambiguous answer — a `403` that may be a
 * permission ruling, a `404` that may mean the endpoint simply does not exist,
 * a rate limit, a server error, a redirect, or no answer at all — is
 * inconclusive, so the Owner keeps the key and its reason rather than being
 * told a secret is wrong on evidence that does not prove it.
 */
export function createGenericKeyProbe(options: KeyProbeOptions = {}): UpstreamKeyProbe {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = options.fetch ?? globalThis.fetch

  return {
    async test({ baseUrl, upstreamKey }): Promise<KeyProbeResult> {
      let modelsUrl: string
      try {
        modelsUrl = new URL(baseUrl.endsWith('/') ? `${baseUrl}models` : `${baseUrl}/models`).href
      } catch {
        return { verdict: 'inconclusive', reason: 'the stored base URL is not a usable URL' }
      }

      let response: Response
      try {
        response = await fetchImpl(modelsUrl, {
          method: 'GET',
          headers: { authorization: `Bearer ${upstreamKey}`, accept: 'application/json' },
          // Following a redirect could carry the key to another origin; the
          // transport rules decide that later, so the probe reports it instead.
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        return timedOut(error)
          ? {
              verdict: 'inconclusive',
              reason: 'the provider did not answer before the test timed out',
            }
          : { verdict: 'inconclusive', reason: 'the provider could not be reached' }
      }

      // The body is irrelevant to the verdict; releasing it frees the socket.
      void response.body?.cancel().catch(() => undefined)

      const { status } = response

      if (status >= 200 && status < 300) return { verdict: 'usable', reason: null }
      if (status === 401) {
        return { verdict: 'rejected', reason: 'the provider rejected the key (HTTP 401)' }
      }
      if (status >= 300 && status < 400) {
        return {
          verdict: 'inconclusive',
          reason: 'the provider redirected the test; redirects are not followed by default',
        }
      }
      if (status === 403) {
        return {
          verdict: 'inconclusive',
          reason: 'the provider refused the models endpoint (HTTP 403); the key may lack permission for it',
        }
      }
      if (status === 404) {
        return {
          verdict: 'inconclusive',
          reason: 'the provider has no models endpoint (HTTP 404)',
        }
      }
      if (status === 429) {
        return {
          verdict: 'inconclusive',
          reason: 'the provider rate-limited the test (HTTP 429)',
        }
      }

      return { verdict: 'inconclusive', reason: `the provider answered with HTTP ${status}` }
    },
  }
}

function timedOut(error: unknown): boolean {
  // `AbortSignal.timeout` raises a DOMException in some runtimes and a plain
  // Error in others, so the name is read structurally.
  if (typeof error !== 'object' || error === null) return false
  const name = (error as { name?: unknown }).name
  return name === 'TimeoutError' || name === 'AbortError'
}
