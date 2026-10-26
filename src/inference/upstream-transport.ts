import type { InferenceForwardRequest } from './adapter.ts'

/**
 * The most same-origin redirect hops Iroha will follow for one upstream call.
 * A redirect chain longer than this is returned to the routing layer as the
 * redirect response itself, never followed forever. Without a cap, a
 * misbehaving upstream that redirects `/a` to `/b` and back would pin the
 * request until the caller or the process gave up.
 */
export const MAX_SAME_ORIGIN_REDIRECTS = 5

/**
 * Options for one upstream exchange. `headerTimeoutMs` bounds the wait for
 * response headers (which includes connection establishment); `totalTimeoutMs`
 * bounds a fully buffered body read. Both are enforced with a real abort, not
 * an advisory check. A value of zero disables that deadline.
 */
export interface UpstreamFetchOptions {
  readonly url: string
  readonly method: InferenceForwardRequest['method']
  readonly headers: Readonly<Record<string, string>>
  readonly body: string | undefined
  readonly follow: 'manual' | 'follow-same-origin'
  readonly origin: string | null
  readonly signal: AbortSignal | null
  readonly headerTimeoutMs: number
  readonly totalTimeoutMs: number
}

/**
 * The live upstream answer plus the handles needed to read a buffered body
 * under the same deadline and to release the timer afterwards.
 */
export interface UpstreamFetchResult {
  readonly response: Response
  /** Reads the whole body, aborting if `totalTimeoutMs` elapses first. */
  readText(): Promise<string>
  /** Cancels any armed deadline timer. Safe to call more than once. */
  dispose(): void
}

/**
 * The one place Iroha issues an upstream request. It owns the redirect policy,
 * the deadline timers, and the merge of the caller's cancellation with Iroha's
 * own timeouts, so every adapter gets the same transport behaviour.
 *
 * Redirects are `manual`. When the caller enabled same-origin redirects the
 * resolved URL may stay on the configured origin; anything cross-origin is
 * returned as-is so credentials never travel to another host.
 */
export async function upstreamFetch(
  fetchImpl: typeof fetch,
  options: UpstreamFetchOptions,
): Promise<UpstreamFetchResult> {
  const controller = new AbortController()
  const signals: AbortSignal[] = [controller.signal]
  if (options.signal !== null) signals.push(options.signal)
  const signal = signals.length === 1 ? controller.signal : AbortSignal.any(signals)

  let timer: ReturnType<typeof setTimeout> | null = null
  const arm = (ms: number): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (ms > 0) {
      timer = setTimeout(() => controller.abort(new Error('upstream timeout')), ms)
    }
  }
  const disarm = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
  const abortError = (): Error =>
    signal.reason instanceof Error ? signal.reason : new Error('upstream request aborted')
  const guard = <T>(promise: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError())
        return
      }
      const onAbort = (): void => reject(abortError())
      signal.addEventListener('abort', onAbort, { once: true })
      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        (cause) => {
          signal.removeEventListener('abort', onAbort)
          reject(cause)
        },
      )
    })

  try {
    arm(options.headerTimeoutMs)

    let currentUrl = options.url
    const currentHeaders = { ...options.headers }
    let response: Response
    let hops = 0
    for (;;) {
      response = await fetchImpl(currentUrl, {
        method: options.method,
        headers: currentHeaders,
        body: options.body,
        redirect: 'manual',
        signal,
      })

      if (response.status < 300 || response.status >= 400) break
      if (options.follow !== 'follow-same-origin') break
      if (options.origin === null) break

      const location = response.headers.get('location')
      if (location === null) break

      const nextUrl = new URL(location, currentUrl).href
      if (!sameOrigin(nextUrl, options.origin)) break

      // The hop is safe to discard before following it.
      void response.body?.cancel().catch(() => undefined)

      // The cap is checked after the current response is validated so an
      // over-limit chain returns the redirect response rather than throwing.
      if (hops >= MAX_SAME_ORIGIN_REDIRECTS) break
      hops += 1
      currentUrl = nextUrl
      // Each hop gets a fresh header budget: a slow redirect should not be
      // allowed to consume the deadline meant for the final response.
      arm(options.headerTimeoutMs)
    }

    disarm()

    return {
      response,
      async readText(): Promise<string> {
        arm(options.totalTimeoutMs)
        try {
          return await guard(response.text())
        } finally {
          disarm()
        }
      },
      dispose(): void {
        disarm()
      },
    }
  } catch (cause) {
    disarm()
    throw cause
  }
}

/** The `{scheme}://{host}:{port}` portion of a base URL, or null when invalid. */
export function sameOriginOf(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return null
  }
}

/** Two URLs share an origin when their scheme, host, and port match. */
export function sameOrigin(url: string, origin: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return `${parsed.protocol}//${parsed.host}` === origin
}

/**
 * Resolves the effective redirect policy for one request. A connection that
 * allows same-origin redirects follows them within its origin; every other
 * connection is handed the redirect response untouched.
 */
export function redirectPolicy(request: {
  readonly redirectAllowSameOrigin: boolean
  readonly baseUrl: string
}): { readonly follow: 'manual' | 'follow-same-origin'; readonly origin: string | null } {
  return request.redirectAllowSameOrigin
    ? { follow: 'follow-same-origin', origin: sameOriginOf(request.baseUrl) }
    : { follow: 'manual', origin: null }
}