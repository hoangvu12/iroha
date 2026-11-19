# 32: Caching reviewed and fixed

**What to build:** The Owner asked (2026-11-20) whether Iroha handles caching well. Research it end to end and fix what's wrong:

- **HTTP:** what the Go server sends for the SPA: `index.html` (must revalidate so a deploy shows up), hashed Vite assets (`/assets/*`, should be `immutable` with a long max-age), fonts, Provider/Pool logos (the logo lookup: cached on the server? sent with `Cache-Control`/`ETag`? what happens when a domain changes), API responses (`no-store` vs private, ETag/304 where cheap), compression (gzip/brotli for JS/CSS/JSON). Check the deploy runbook's reverse proxy if it adds headers.
- **Client:** TanStack Query defaults (`staleTime`, `gcTime`, `refetchOnWindowFocus`, retries), per-query overrides, invalidation after each mutation (does every save refresh the right lists and sheets, without refetching everything?), `placeholderData` use, prefetching on hover/route, the Requests feed's live updates, and anything cached in `localStorage` (chat history, view choices).
- **After a deploy:** an open tab with old JS asks for a chunk that no longer exists; does it recover (reload once) instead of breaking?

Write the findings with sources (MDN, TanStack Query docs, Vite docs) to `docs/research/ui-caching.md`: what's right, what's wrong, what was changed. Then fix the clear problems test-first (Go tests for headers; web tests for invalidation), and list anything that needs the Owner's choice instead of changing it.

**Blocked by:** none

**Status:** open

Owner request, 2026-11-20.

- [ ] Research written to `docs/research/ui-caching.md` with sources
- [ ] Clear problems fixed with tests (Go and web); open choices listed
- [ ] Checked in headless Chrome: a hard reload and a normal reload of a built UI, cache headers seen in DevTools/curl, light, dark and phone width for any visible change
