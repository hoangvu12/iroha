import { join, relative, resolve, sep } from 'node:path'

/**
 * Serves the built management UI from the same process as the API.
 *
 * The UI is a single-page application, so any path that does not match a built
 * asset falls back to `index.html` and lets the browser router decide. Missing
 * builds are reported rather than hidden, because `bun start` without
 * `bun run build` is a common first mistake.
 */
export interface FrontendHandler {
  (pathname: string): Promise<Response>
}

/** Hashed Vite output is immutable; the entry document must never be cached. */
const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable'
const DOCUMENT_CACHE_CONTROL = 'no-cache'

export function createFrontendHandler(directory: string): FrontendHandler {
  const root = resolve(directory)
  const indexPath = join(root, 'index.html')

  return async (pathname) => {
    const index = Bun.file(indexPath)

    if (!(await index.exists())) {
      return notBuilt()
    }

    const requested = resolveWithinRoot(root, pathname)

    if (requested !== null && requested !== indexPath) {
      const file = Bun.file(requested)
      if (await file.exists()) {
        return new Response(file, { headers: { 'cache-control': ASSET_CACHE_CONTROL } })
      }
    }

    return new Response(index, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': DOCUMENT_CACHE_CONTROL },
    })
  }
}

/**
 * The absolute path a request names, or `null` when it escapes the build
 * directory. `..` segments and absolute paths in the URL must not be able to
 * read `.env` or a SQLite file sitting next to the build output.
 */
function resolveWithinRoot(root: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }

  if (decoded.includes('\0')) return null

  const candidate = resolve(root, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`)
  const within = relative(root, candidate)

  if (within === '') return null
  if (within.startsWith('..') || within.startsWith(`${sep}..`)) return null

  return candidate
}

function notBuilt(): Response {
  return new Response(
    'The Iroha management UI has not been built. Run `bun run build`, or use `bun run dev` for the Vite dev server.',
    { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } },
  )
}
