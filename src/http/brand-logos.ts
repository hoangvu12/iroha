import { Elysia, t } from 'elysia'
import type { BrandLogoService } from '../brand-logos/index.ts'

export interface BrandLogoRoutesOptions {
  readonly brandLogos: BrandLogoService
}

const notFoundResponse = t.Object({
  error: t.Object({
    code: t.String(),
    message: t.String(),
  }),
})

/**
 * Public route that streams a Provider Template's brand logo bytes. The
 * template's brand is data-only, the bytes come from the server's cache,
 * and there is no per-tenant material in the response, so the route does
 * not demand an Owner session or a Gateway Key. A browser hot-loading the
 * management UI is the primary caller.
 *
 * Every null from the service — unknown template, missing brand, missing
 * logo.dev token, upstream refusal — collapses into a single 404 so the
 * UI's `<img onerror>` fallback is the only consumer-side branch needed.
 */
export function createBrandLogoRoutes({ brandLogos }: BrandLogoRoutesOptions) {
  return new Elysia({ name: 'iroha/brand-logos', prefix: '/api/v1/brand-logos' }).get(
    '/:templateId',
    async ({ params, query, status, set }) => {
      const logo = await brandLogos.getLogo(params.templateId, query.theme ?? 'auto')
      if (logo === null) {
        set.headers['cache-control'] = 'public, max-age=60'
        return status(404, { error: { code: 'brand_logo_unavailable', message: 'No brand logo for this template.' } })
      }
      set.headers['content-type'] = logo.contentType
      set.headers['cache-control'] = 'public, max-age=86400'
      return logo.bytes
    },
    {
      query: t.Optional(
        t.Object({
          theme: t.Optional(t.Union([t.Literal('light'), t.Literal('dark'), t.Literal('auto')])),
        }),
      ),
      detail: {
        tags: ['Brand Logos'],
        summary: 'Fetch a Provider Template brand logo',
        description:
          'Streams the cached logo.dev image for one built-in Provider Template. The optional `theme` query selects a variant adjusted for a light or dark background. Returns 404 when the template has no brand, the deployment has no logo.dev token, or the upstream refused. The bytes are served as image/webp (or whatever logo.dev returned) and may be cached by the browser for a day.',
      },
      response: {
        200: t.Uint8Array(),
        404: notFoundResponse,
      },
    },
  )
}

export type BrandLogoRoutes = ReturnType<typeof createBrandLogoRoutes>
