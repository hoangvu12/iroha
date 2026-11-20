# 32: Caching reviewed and fixed

**What to build:** The Owner asked (2026-11-20) whether Iroha handles caching well. Research it end to end and fix what's wrong:

- **HTTP:** what the Go server sends for the SPA: `index.html` (must revalidate so a deploy shows up), hashed Vite assets (`/assets/*`, should be `immutable` with a long max-age), fonts, Provider/Pool logos (the logo lookup: cached on the server? sent with `Cache-Control`/`ETag`? what happens when a domain changes), API responses (`no-store` vs private, ETag/304 where cheap), compression (gzip/brotli for JS/CSS/JSON). Check the deploy runbook's reverse proxy if it adds headers.
- **Client:** TanStack Query defaults (`staleTime`, `gcTime`, `refetchOnWindowFocus`, retries), per-query overrides, invalidation after each mutation (does every save refresh the right lists and sheets, without refetching everything?), `placeholderData` use, prefetching on hover/route, the Requests feed's live updates, and anything cached in `localStorage` (chat history, view choices).
- **After a deploy:** an open tab with old JS asks for a chunk that no longer exists; does it recover (reload once) instead of breaking?

Write the findings with sources (MDN, TanStack Query docs, Vite docs) to `docs/research/ui-caching.md`: what's right, what's wrong, what was changed. Then fix the clear problems test-first (Go tests for headers; web tests for invalidation), and list anything that needs the Owner's choice instead of changing it.

**Blocked by:** none

**Status:** done

Owner request, 2026-11-20.

- [x] Research written to `docs/research/ui-caching.md` with sources
- [x] Clear problems fixed with tests (Go and web); open choices listed
- [x] Checked in headless Chrome: a hard reload and a normal reload of a built UI, cache headers seen in DevTools/curl, light, dark and phone width for any visible change

## Comments

**Research.** `docs/research/ui-caching.md` reviews each layer and says what was right, what was wrong and what changed. Its Sources section gathers the primary-source facts with URLs: MDN, RFC 9110/9111, the HTML spec, web.dev and Chrome, Cloudflare, TanStack Query v5 and Vite. Production is Cloudflare, then nginx, then Iroha. The Owner had already decided compression (ticket 36: Cloudflare compresses).

**Already right:**
- `index.html` is `no-cache`; hashed `/assets/*` (fonts included) are cached for a year as `immutable`.
- The server-side logo cache works.
- The TanStack Query defaults and per-query overrides are sound, including `keepPreviousData` on filtered and paged queries.
- Sign-in and sign-out drop the cache, and no query cache is persisted.

**Fixed, test-first** (each test written and seen failing before the code):
1. **ETags on everything the UI server sends**: the app page, assets and brand art. A revalidated page is now a 304. A missing file is `no-store`, because Cloudflare otherwise caches a `.js` 404 for 3 minutes. Test: `webui TestUICachingAndPathsThatClimbOutOfTheBundle`.
2. **Logos showed the old image for up to an hour after a logo domain or maker changed**, everywhere the URL had no `?v=`: the Requests feed, sheets, Gateway Keys, the chat and Audit Entries. A record's logo is now `private, no-cache` with an ETag, so it is a 304 when unchanged. Previews keep an hour. Test: `logos TestARecordsLogoIsRevalidatedSoADomainChangeShowsAtOnce`.
3. **Admin API answers had no `Cache-Control`**, though they hold secrets. Every `/api/` answer is now `no-store`. Test: `server TestAdminAPIAnswersAreNeverStored`.
4. **Revert on Audit Entries refreshed only the Settings lists**, so open sheets and other pages showed the state from before the revert. It now refreshes all configuration (`api/refresh.ts`). Test: `revert-refresh.test.tsx`.
5. **Gateway Key changes didn't refresh the chat's Send as list, the chat's model choices or a Pool's Members tab**, and Providers changes didn't refresh the chat's model choices. Tests: `invalidate.test.tsx`, `refresh.test.tsx`.
6. **The Requests feed's live poll ran every 2 s in a hidden tab.** It now pauses and catches up when the tab is shown. Test: `live-hidden.test.tsx`.
7. **After a deploy, an open tab went blank on its first lazy page or sheet.** It now reloads once on `vite:preloadError`, without looping. Test: `stale-chunks.test.ts`.

**Open choices** (not changed, see the doc):
- tell an open tab that a new version is out (`/readyz` already reports the version);
- clear test chats on sign-out;
- compress when Iroha is reached directly;
- check Cloudflare's Browser Cache TTL setting with one `curl -I` on the live host;
- prefetch on hover;
- cap the live feed's memory in long sessions.

**Browser check:**
- The scripts and results are in `iroha-v2-notes/v2-ui/shots/32/`: `check32.mjs`, `probe32.mjs`, `report.txt` and screenshots `providers-{light,dark,phone,phone-dark}.png`. They ran against a local binary of this branch, with logos fetched from its own brand art and no external calls.
- A normal reload took every asset from the browser cache (0 bytes) and got logo 304s. A hard reload fetched the assets again.
- The `curl -I` headers are in `report.txt`.
- With the Requests chunk answered 404, the tab reloaded once and didn't loop.
- No visible UI change; the screenshots are a sanity check.
