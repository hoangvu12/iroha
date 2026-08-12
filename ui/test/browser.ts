import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { TestApp } from '../../test/support/app.ts'

/**
 * A DOM for the management application, wired to a real Iroha.
 *
 * There is no headless browser in this repository's toolchain, so "browser
 * test" here means: the real React application rendered into a real DOM, whose
 * `fetch` reaches the assembled Elysia app over a cookie jar that behaves the
 * way a browser's does. What it does not cover is browser-enforced behaviour —
 * `HttpOnly`, `SameSite`, and `Secure` are asserted on the `Set-Cookie` header
 * itself in `test/http/`, because only a real browser could enforce them.
 */
/**
 * Registers happy-dom exactly once per process.
 *
 * It is deliberately never unregistered mid-suite: user-event captures
 * `document` at import time, and an unregister would strand that reference
 * permanently — a later register creates a different document than the one
 * those modules hold.
 */
export function registerDom(): void {
  if (registered) return

  // happy-dom brings its own HTTP primitives. Iroha's own `Request`/`Response`
  // handling must stay on Bun's, or `app.handle` would receive a different
  // object than it does in production.
  const native = {
    fetch: globalThis.fetch,
    Request: globalThis.Request,
    Response: globalThis.Response,
    Headers: globalThis.Headers,
    FormData: globalThis.FormData,
    Blob: globalThis.Blob,
    AbortController: globalThis.AbortController,
    AbortSignal: globalThis.AbortSignal,
  }

  GlobalRegistrator.register({ url: 'http://iroha.test' })

  Object.assign(globalThis, native)
  registered = true
}

let registered = false

/**
 * Points the page's `fetch` at the running application, so the components under
 * test make exactly the requests they would make in a browser.
 */
export function useGatewayAsFetch(iroha: TestApp): () => void {
  const original = globalThis.fetch

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input.toString()
    const path = raw.startsWith('http') ? new URL(raw).pathname + new URL(raw).search : raw
    return iroha.fetch(path, init)
  }) as typeof fetch

  return () => {
    globalThis.fetch = original
  }
}
