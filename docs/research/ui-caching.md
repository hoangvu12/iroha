# Caching in Iroha's UI and admin API (UI ticket 32)

The Owner asked (2026-11-20) whether Iroha handles caching well. This note reviews every layer end to end: what the Go server sends, what sits in front of it, and what the web client keeps. For each area it says what was right, what was wrong and what changed. The primary-source facts it relies on are in "Sources" at the end, each with its URL. Open choices for the Owner are listed separately; nothing in that list was changed.

## What sits in front of Iroha in production

- Cloudflare, then nginx on the server, then Iroha on `127.0.0.1:8080`. Sources: the cutover runbook (`.scratch/v2-gateway/cutover/README.md`, "How the public hostname was switched") and the deploy runbook (`internal/api/skill/50_deploy.md`). Neither `deploy/` nor the runbooks configure nginx headers, so nginx passes Iroha's headers through. Nothing here was checked against production (no SSH, no calls).
- Cloudflare caches by file extension only, never HTML or JSON by default. It respects origin `Cache-Control` (`private`, `no-store`, `no-cache` are not stored). It caches a 404 for 3 minutes when the origin sends no `Cache-Control`. It compresses HTML, CSS, JS, JSON and SVG to visitors (gzip, Brotli or Zstandard). See Sources §2.
- Compression was decided by the Owner on 2026-11-19 (gateway ticket 36, closed): Cloudflare compresses at the edge, and Iroha doesn't compress.

## Findings

### HTTP: the UI's files (`internal/webui`)

| What | Before | Verdict | After |
|---|---|---|---|
| `index.html` (also served for every app path) | `no-cache`, no validator | Right policy, as MDN and Vite recommend. Without an ETag, though, every load downloaded the whole page. | `no-cache` plus a strong ETag, so an unchanged page is a 304. |
| Hashed Vite files `/assets/*` (JS, CSS, Inter `woff2`) | `public, max-age=31536000, immutable` | Right. Vite puts a hash in each file name. Chrome ignores `immutable`, but it doesn't revalidate subresources on a normal reload anyway (Sources §1). | Unchanged, plus an ETag. |
| Brand art `/brand/*` | `public, max-age=86400` | Right: public art, fixed names, a day is enough. Once stale, though, it was downloaded whole. | Unchanged, plus an ETag (a 304 after a day). |
| A missing file (`/assets/old-chunk.js`) | JSON 404 with no `Cache-Control` | **Wrong.** A 404 is heuristically cacheable, and Cloudflare keeps a `.js` 404 for 3 minutes. A chunk asked for during a deploy could stay "missing" at the edge after it existed. | `Cache-Control: no-store` on the miss. |
| Compression | None (Cloudflare does it) | Owner's choice (ticket 36). The UI is ~1.3 MB of JS and 73 KB of CSS uncompressed (~400 KB gzipped). It only arrives uncompressed on a direct connection, such as an SSH tunnel to `127.0.0.1:8080`. | Unchanged. See Open choices. |

### HTTP: logos (`internal/logos`)

- **Server-side cache: right.** Each logo is kept in memory and in `<data-dir>/logos` for a day. A miss is kept for a minute, a failed refetch keeps the stale copy, and only one fetch per key runs at a time. The cache key is the domain or maker, so a changed logo domain is a new key and is fetched fresh.
- **Browser side: wrong.** `/api/providers/{p}/logo` and `/api/pools/{p}/logo` were `private, max-age=3600` with no validator, but their URL doesn't change when the logo domain or maker does.
  - `?v=<logo_domain>` on the URL busts the cache only where a page has the record at hand (Providers list, Provider and Pool headers and sheets).
  - Everywhere else used the bare URL: the Requests feed, Gateway Key pages, Pool members and route, the chat picker, Audit Entries, Key and Endpoint sheets. Those places kept the old logo for up to an hour after a change, across reloads.
  - **Changed:** those two routes now send `private, no-cache` and an ETag, misses included. A reload asks again and an unchanged logo costs a 304.
  - A logo already drawn in the open tab is still reused for the same URL without a request: the HTML "list of available images" (Sources §1). So within one tab, the versioned URLs are what make a change show at once. They stay.
- `/api/logos?domain=|maker=` (the preview while typing) names its domain in the URL, so it keeps `private, max-age=3600` and now also has an ETag.

### HTTP: admin API (`internal/api` Router)

- **Before:** JSON answers had no `Cache-Control`. Browsers may store such answers and reuse them heuristically (the rules are unspecified; Sources §1). Those answers include readable Upstream Keys, Gateway Keys and Admin Token secrets (ADR-0006), so they could end up in the browser's disk cache.
- **Changed:** every `/api/` answer, errors and unknown routes included, is now `Cache-Control: no-store` (set in `Router.ServeHTTP`). A Raw route can override it, as logos do.
- Why `no-store` rather than MDN's general `private, no-cache`:
  - The UI never reuses HTTP-cached API answers; TanStack Query is its cache.
  - The answers hold secrets that shouldn't sit on disk.
  - MDN's warning about `no-store` and the back/forward cache concerns `no-store` *pages*. The app page is `no-cache`, so `no-store` on fetches doesn't block bfcache (Sources §1).
- **ETag/304 on the API: not added.** TanStack Query refetches on its own timing. An ETag would save bytes but no server work (the body must be built to hash it), and Cloudflare already compresses. The busiest poll, the Requests feed, already sends only changes (`changed_after` cursor). Not worth it now.
- Gateway inference routes (`/v1/...`) are for Callers, not browsers. They are unchanged: streams already send `no-cache`.

### Client: TanStack Query (`web/src`)

Defaults in `app/App.tsx` are right:
- `staleTime` is 10 s. TanStack's default is 0, which refetches on every mount.
- `refetchOnWindowFocus` is on.
- Retries are only for no answer or a 5xx, twice, with TanStack's backoff, instead of TanStack's 3 retries on any error.
- `gcTime` is TanStack's default, 5 minutes.
- Mutations aren't retried (TanStack's default).
- Polls use `refetchInterval`, which stops in a hidden tab (TanStack's default `refetchIntervalInBackground: false`).
- Session changes drop every cached answer: sign-in, sign-out and an ended session (`api/session.ts`, `AuthGate`).
- No query cache is persisted to storage.

Per-query overrides are reasoned and right:
- The session never goes stale by itself.
- `/readyz` is polled every 15 s.
- Keys poll every 10 s, the overview every 15 s, the Pool route preview every 5 s, Gateway Keys every 30 s.
- A Request in progress polls every 2 s.
- Captures never go stale (`Infinity`): they don't change.
- `keepPreviousData` is used wherever a filter, page or search changes the key (Skullet rule, ticket 02).
- The Request sheet uses `placeholderData` seeded from the feed row.
- The Gateway Key page uses `placeholderData` from the cached list.

Invalidation after mutations: each area has one refresh helper, and every mutation and every Undo runs it.
- Providers: `useRefresh`.
- Gateway Keys: `useInvalidateKeys`.
- Settings: `useInvalidateAll`.
- `invalidateQueries` refetches only the queries on screen and marks the rest stale (Sources §3), so the wide Providers helper costs only what is shown.

Gaps found and fixed:
1. **Revert on Settings → Audit Entries refreshed only Admin Tokens, Audit Entries and signed-in browsers.**
   - A revert can change any record. After reverting a key, Provider or Gateway Key change, an open record sheet (they open over Audit Entries through RecordLinks) showed the old state.
   - So did any other page visited within `staleTime`.
   - **Fixed:** Revert runs `refreshConfiguration` (`api/refresh.ts`). It marks every cached answer stale except the session, `/readyz`, the Requests history and the logo lookups.
   - Test: `pages/settings/revert-refresh.test.tsx`.
2. **A Gateway Key change didn't refresh the other lists of Gateway Keys.**
   - The chat's "Send as" list and a Pool's Members tab read `["providers-page", "gateway-keys"]`.
   - The chat's model choices (`["test-models", …]`) depend on the key's scope.
   - A key created and then picked within 10 s was missing. A scope change took 30 s to show in the chat's choices.
   - **Fixed** in `useInvalidateKeys`. Test: `pages/gateway-keys/invalidate.test.tsx`.
3. **A Providers page change didn't refresh the chat's model choices** (30 s `staleTime`): a new Provider or Pool, or a model hidden or added. **Fixed** in `useRefresh`. Test: `pages/providers/refresh.test.tsx`.
4. **The Requests feed's live poll kept running in a hidden tab.** Its own `setTimeout` loop calls `changed_after` every 2 s, unlike every `refetchInterval` poll. Chrome throttles it only after minutes.
   - **Fixed:** the loop pauses while `document.hidden` and catches up at once on `visibilitychange`. The cursor makes the catch-up complete (it drains up to 5 pages per tick).
   - Test: `pages/requests/live-hidden.test.tsx`.

Prefetching:
- The Request sheet prefetches its neighbours in the feed (and their captures on the Captured tab), so ↑/↓ never shows a skeleton. That's right.
- There's no hover or route prefetch elsewhere; see Open choices.
- TanStack's newest v5 docs mark `prefetchQuery` deprecated in favour of `query()` (Sources §3). The installed 5.108 still has it, so nothing changes now.

### Client: what is kept in `localStorage`

| Key | What | Cleared on sign-out |
|---|---|---|
| `iroha.theme` | Light, dark or system | No (not data) |
| `skullet:shapes` | Skeleton shapes of pages seen | Yes (`forgetShapes`) |
| `iroha:table:<id>:page-size` | Rows per page per table | No (a view choice) |
| `iroha:requests:paging` | Live feed or numbered pages | No (a view choice) |
| `iroha.chats.v1` | Up to 30 test chats, messages included (ticket 23's decision) | **No**: see Open choices |
| recent chat models | Last 12 models picked | No |
| `iroha:stale-chunk-reload-at` (sessionStorage, new) | When the tab last reloaded for a missing chunk | Ends with the tab |

Every read and write is in `try/catch`, or it's a value whose loss is harmless.

### After a deploy: an open tab with the old build

- **Before:** pages and sheets are lazy chunks (`App.tsx`, `sheets/SheetStack.tsx`). A tab opened before a deploy asked for a chunk the new binary doesn't embed and got a 404. `React.lazy` threw with no error boundary, and the whole app went blank until a manual reload.
- **Changed:** `app/stale-chunks.ts` listens for Vite's `vite:preloadError`, which Vite fires when a dynamic import fails (Sources §4), and reloads the tab once.
  - The reload fetches the new `index.html`, which is never served from cache unchecked (`no-cache`), so the tab gets the new chunks.
  - A second failure within 10 s of that reload (`sessionStorage`) doesn't reload again, so a chunk that's really missing can't loop.
  - The listener doesn't call `preventDefault()`, so that failure still throws.
  - Test: `app/stale-chunks.test.ts`. Checked in headless Chrome by answering the Requests chunk with a 404 (below).
- Not changed: a tab that never asks for a new chunk keeps running the old build until it is reloaded. See Open choices.

## Checked in headless Chrome

`iroha-v2-notes/v2-ui/shots/32/check32.mjs` (outside the repo) runs against a seeded testkit server built with this branch's UI. It records what each load fetched and from where, simulates a deploy that removed the Requests chunk, and takes light, dark and phone screenshots of Providers (no visible change was made). Results: `shots/32/report.txt` and the PNGs beside it.

The check ran against a local binary of this branch on `127.0.0.1:3770`, with logos fetched from its own brand art.

- **First load of `/providers`:**
  - The page came back `no-cache` with an ETag.
  - Every `/assets/*` file was `public, max-age=31536000, immutable` with an ETag.
  - API calls were `no-store`.
  - Record logos were `private, no-cache` with an ETag; the logo miss was `private, no-cache`.
- **Normal reload:**
  - The page was revalidated.
  - All 29 `/assets/*` requests came from the browser cache, 0 bytes over the wire (`probe32.mjs`).
  - Both logos answered 304.
  - Brand art came from the disk cache.
- **Hard reload:** the assets were fetched again (expected). The logos still answered 304 because the server's ETag matched.
- **`curl -I`:**
  - `If-None-Match` with the page's ETag gave 304.
  - A missing `/assets/*.js` gave 404 with `no-store`.
  - A logo with its ETag gave 304.
- **Stale chunk:**
  - The Requests chunk was answered 404 while navigating from Providers to Requests. The tab reloaded once.
  - The reloaded page failed on the same chunk and didn't reload again (still 1 load after 4 s).
  - With the chunk back, a reload showed Requests.
- **Screenshots:** Providers in light, dark, phone and phone dark looked as before (`providers-*.png`).

## Open choices for the Owner (not changed)

1. **Tell an open tab when Iroha was updated.** The UI already polls `/readyz`, which reports the version. It could show "Iroha was updated: Reload" when the version changes, instead of running the old build until the next chunk load or manual reload.
2. **Clear test chats on sign-out.** `iroha.chats.v1` keeps up to 30 chats, prompts and answers included, in the browser after sign-out. Skeleton shapes are cleared then, but chats aren't. On a shared browser that may matter.
3. **Compress when reached directly.** Ticket 36 decided that Cloudflare compresses. If the Owner often reaches Iroha without Cloudflare (an SSH tunnel to `127.0.0.1:8080`), the UI's ~1.3 MB of JS is sent uncompressed the first time. It's cached for a year after that. Pre-compressing the embedded files at build time would be cheap. Alternatively, nginx could gzip (`gzip_types` for JS, CSS and JSON).
4. **Check Cloudflare's Browser Cache TTL setting** on the zone. Cloudflare's docs say that for responses without `Cache-Control` it rewrites the browser lifetime to 4 hours, unless "Respect Existing Headers" is set. They don't say whether this touches `no-cache` HTML (Sources §2, unconfirmed). Every UI answer now carries `Cache-Control`. Running `curl -sI https://<host>/providers` once and looking for `cache-control: no-cache` would settle it; it wasn't done here (no production calls).
5. **Prefetch on hover.** Provider rows, Pool rows and nav links could prefetch their page's first query on hover or focus. Pages already open fast on a warm cache, so this is polish, not a fix.
6. **Feed memory over long sessions.** The live feed keeps every Request that arrived since its first page (`changes`), so a tab left on Live for a day of heavy traffic grows without bound. Capping it (keep the newest N, drop older live rows) is a product choice about what Live shows.

## Sources

Fetched 2026-11-20. Each bullet quotes or closely paraphrases the page at its URL. "Unconfirmed" means no fetched primary source stated it.

### 1. HTTP caching

#### Directives

- `no-cache`: "the response can be stored in caches, but the response must be validated with the origin server before each reuse". The page also says "`no-cache` does not mean 'don't cache'". https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control
- `no-store`: "any caches of any kind (private or shared) should not store this response". Same URL.
  - `no-store` "does not delete any already-stored response for the same URL", so an old stored copy can still be reused. `no-cache` instead "will force the client to send a validation request before reusing any stored response". https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching
- `private`: the response "can be stored only in a private cache (e.g., local caches in browsers)".
  - MDN: "You should add the `private` directive for user-personalized content, especially for responses received after login and for sessions managed via cookies." https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control
- `public`: the response can be stored in a shared cache even when the request had an `Authorization` header.
  - "If a request doesn't have an `Authorization` header, or you are already using `s-maxage` or `must-revalidate` in the response, then you don't need to use `public`." Same URL.
  - RFC 9111 §3.5: a shared cache must not reuse a response to an Authorization request unless `must-revalidate`, `public` or `s-maxage` allows it. https://www.rfc-editor.org/rfc/rfc9111.html#section-3.5
- `max-age=N`: the response stays fresh "until N seconds after the response is generated". This is not N seconds after it is received, because `Age` is deducted.
  - Negative or non-integer values: behaviour is unspecified, and caches are "encouraged to treat the value as if it were 0". https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control
- `must-revalidate`: the response can be reused while fresh. Once stale, it "must be validated with the origin server before reuse", or the cache returns a 504; without it, a disconnected cache may serve stale. Same URL.
  - MDN: "there's no reason to ever use that `max-age=0` and `must-revalidate` combination — you should instead just use `no-cache`." https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching
- `immutable`: "the response will not be updated while it's fresh". It avoids conditional requests on reload. https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control
  - Which browsers honour it (MDN browser-compat-data):
    - Firefox 49+, Safari 11+ / iOS 11+: yes.
    - Chrome, Chrome Android, Opera, Samsung Internet, Android WebView: no.
    - Legacy Edge supported it in versions 15–18 and dropped it in Chromium Edge 79.
    - Sources: https://bcd.developer.mozilla.org/bcd/api/v0/current/http.headers.Cache-Control.json (the table behind the MDN page).
  - The MDN guide explains Chrome's position: "instead of implementing that directive, Chrome has changed its implementation so that revalidation is not performed during reloads for subresources." https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching
- Conflicting directives: `private, no-cache, no-store, max-age=0, must-revalidate` is "equivalent to" `no-store`, because "the most restrictive directive should be honored". https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control

#### Heuristic freshness (no Cache-Control)

- Responses without `Cache-Control` are still cached. MDN: "even if no `Cache-Control` is given, responses will get stored and reused if certain conditions are met. This is called heuristic caching."
  - MDN's only example uses `Last-Modified`. The spec "recommends about 10%" of the time since the last modification.
  - Advice: "basically all responses should explicitly specify a `Cache-Control` header." https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching
- RFC 9111 §4.2.2: a cache "MAY assign a heuristic expiration time when an explicit time is not specified, employing algorithms that use other field values (such as the Last-Modified time)". The RFC "does not provide specific algorithms".
  - Heuristics apply only to status codes "defined as 'heuristically cacheable'", or to responses marked `public`.
  - With a `Last-Modified`, "A typical setting of this fraction might be 10%."
  - The RFC 2616 ban on heuristics for URLs with `?` "has not been widely implemented", so origins should send explicit directives such as `no-cache`.
  - https://www.rfc-editor.org/rfc/rfc9111.html#section-4.2.2
- RFC 9110 §15.1 lists the heuristically cacheable codes: "200, 203, 204, 206, 300, 301, 308, 404, 405, 410, 414, and 501". **A 404 qualifies.** https://www.rfc-editor.org/rfc/rfc9110.html#section-15.1
- A 200 JSON with no `Cache-Control` and no `Last-Modified`:
  - The spec allows a heuristic lifetime but defines no algorithm and no input other than `Last-Modified`.
  - **Unconfirmed** whether any browser actually gives such a response a non-zero heuristic lifetime. No fetched first-party source states browser behaviour without `Last-Modified`.
  - Don't rely on either outcome; send an explicit `Cache-Control`.

#### Validators: ETag, If-None-Match, 304

- When a stored response goes stale, the client sends `If-None-Match` with the stored `ETag` (or `If-Modified-Since`). The server answers `304 Not Modified` with no body if the resource is unchanged, otherwise `200`. https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching
- "RFC9110 prefers that servers send both `ETag` and `Last-Modified` … if both `If-Modified-Since` and `If-None-Match` are present, then `If-None-Match` takes precedence". Same URL.
- Weak ETags (`W/"…"`) "might be semantically equivalent, but not byte-for-byte identical". They are "easy to generate, but are far less useful for comparisons". Weak ETags prevent caching of byte-range requests. https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/ETag
- RFC 9110 §13.1.2: "A recipient MUST use the weak comparison function when comparing entity tags for If-None-Match", so a weak ETag is enough for 304 revalidation. https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.2
- RFC 9110 §8.8.3.2: strong comparison requires that "both are not weak and their opaque-tags match character-by-character". Weak comparison matches the opaque-tags whether or not they are weak. https://www.rfc-editor.org/rfc/rfc9110.html#section-8.8.3.2

#### SPA pattern: HTML revalidated, hashed assets immutable

- Hashed assets (MDN, "Caching static assets with 'cache busting'"): "You can add a long `max-age` value and `immutable` because the content will never change". Example: `/assets/*` → `Cache-Control: max-age=31536000, immutable`.
- HTML: "Use a `no-cache` to make sure that the HTML response itself is not cached … the client will correctly receive a new version of the HTML response and static assets." Example: `/index.html` → `Cache-Control: no-cache`.
- Both rules come from https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control
- The MDN guide's "Main resources" section says the same:
  - "`no-cache` would be appropriate — rather than `no-store`".
  - Add `ETag`/`Last-Modified` so the server can answer with a 304.
  - "The same can be used for `favicon.ico`, `manifest.json`, `.well-known`, and API endpoints whose URLs cannot be changed using cache busting." https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching
- Use `public, max-age=31536000` only "If you never personalize responses via Authorization". Otherwise use `max-age=2592000`. Same URL.

#### Personal or sensitive data, and Vary

- Personalized responses need `private`: "if the service implements cookies or other login methods, and the content is personalized for each user, `private` must be given too".
- MDN does not recommend `no-store` everywhere: "it's not recommended to grant `no-store` liberally, because you lose many advantages … including the browser's back/forward cache". It prefers "`no-cache` in combination with `private`".
- Both points: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching
- web.dev: `no-store` "should only be set on pages that contain sensitive information where caching of any sort is never appropriate". https://web.dev/articles/bfcache
- Request collapse: when requests arrive together, a response can be reused "even if `max-age=0` or `no-cache` is given". Add `private` to personalized responses so they are not shared this way. https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching
- `Vary` keys the cache on request headers as well as the URL, for example `Accept-Language` or `Accept-Encoding`.
  - Avoid `Vary: User-Agent`.
  - "For applications that employ cookies to prevent others from reusing cached personalized content, you should specify `Cache-Control: private` instead of specifying a cookie for `Vary`." Same URL.
- "The same Vary header value should be used on all responses for a given URL, including 304 Not Modified responses". https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Vary

#### no-store and the back/forward cache (bfcache)

- web.dev: when `Cache-Control: no-store` is "set on the page resource itself (as opposed to any subresource)", browsers have historically kept the page out of the bfcache.
  - `no-cache` and `max-age=0` "don't affect a page's bfcache eligibility".
  - In-progress `fetch()`/XHR requests can also stop some browsers from using the bfcache.
  - https://web.dev/articles/bfcache
- Chrome has changed this. Chrome now allows bfcache for `no-store` pages "when this is safe to do". Experiments ran from Chrome 116, with "final rollout to 100% of users over March and April 2025".
  - The page is evicted "on changes to cookies, or other authorization methods".
  - WebSocket, WebTransport and WebRTC still block it.
  - "if a Cache-control: no-store page makes a fetch or XHR request and that returns Cache-control: no-store on its response, then this will also evict the page".
  - The bfcache timeout for these pages is 3 minutes instead of 10.
  - "Other browsers may still block bfcache usage when Cache-Control: no-store is used."
  - https://developer.chrome.com/docs/web-platform/bfcache-ccns
- **So `no-store` on fetch/XHR responses matters only for pages that are themselves `no-store`.** Per these two sources, on a page that is not `no-store` (for example an SPA shell served with `no-cache`), `no-store` API responses do not block the bfcache. No other effect is documented.
- History navigations: `no-cache` "does not guarantee revalidation for history navigations". With bfcache "the browser restores a snapshot of the page without revalidating". https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control

#### Image reuse within a document (HTML spec "list of available images")

- "Each `Document` object must have a list of available images".
  - The key is the absolute URL plus the CORS mode, with the origin added when the mode is not No CORS.
  - The list exists "to avoid re-downloading images in the same document even when they don't allow caching per HTTP".
  - https://html.spec.whatwg.org/multipage/images.html#list-of-available-images
- "Update the image data", step 8 (only for `src` without `srcset`/`<picture>`): if the list has an entry for the key, the user agent sets its "ignore higher-layer caching" flag and uses the entry's data as "completely available". It then fires `load` and skips the fetch.
  - **So an `<img>` whose URL is already loaded in the document is reused with no request and no revalidation, whatever its Cache-Control.** Same page.
- Entries with the ignore flag unset must follow HTTP caching semantics. Fetched images are added "with the ignore higher-layer caching flag set". User agents "may also remove images from such lists at any time (e.g. to save memory)", so reuse is permitted but not guaranteed. Same page.
- The list does not cover an image that is still loading: "It is not used to avoid re-downloading the same image while the previous image is still loading." Same page.

### 2. Cloudflare

- Cached by default (by extension, not MIME type): 7Z, APK, AVI, AVIF, BIN, BMP, BZ2, CLASS, CSS, CSV, DMG, DOC, DOCX, EJS, EOT, EPS, EXE, FLAC, GIF, GZ, ICO, ISO, JAR, JPEG, JPG, JS, MID, MIDI, MKV, MP3, MP4, OGG, OTF, PDF, PICT, PLS, PNG, PPT, PPTX, PS, RAR, SVG, SVGZ, SWF, TAR, TIF, TIFF, TTF, WEBM, WEBP, WOFF, WOFF2, XLS, XLSX, ZIP, ZST, plus robots.txt. https://developers.cloudflare.com/cache/concepts/default-cache-behavior/
- "Cloudflare only caches based on file extension and not by MIME type. The Cloudflare CDN does not cache HTML or JSON by default." Same URL.
- Cloudflare **does not** cache when "The `Cache-Control` header is set to `private`, `no-store`, `no-cache`, or `max-age=0`", when `Set-Cookie` is present, or for non-GET requests.
  - It **does** cache with `public` plus `max-age` > 0, or with a future `Expires`.
  - `max-age` wins over `Expires`. Same URL.
- Origin Cache Control is on by default for Free, Pro and Business plans. The detailed table qualifies the rule above:
  - With Origin Cache Control on, `no-cache` / `max-age=0` → "Caches and always revalidates". `no-cache` also "Does not serve stale".
  - `private` → must not be stored by "a shared cache like Cloudflare".
  - `no-store` → "Will not cache".
  - `immutable` "has no effect on public caches like Cloudflare, but does change browser behavior".
  - https://developers.cloudflare.com/cache/concepts/cache-control/
- Default edge TTL "when a `cache-control` directive or `expires` response header are not present": 200, 206, 301 → 120m; 302, 303 → 20m; **404, 410 → 3m**. "All other status codes are not cached by default."
  - "Cloudflare does cache the resource even if there is no `Cache-Control` header based on status codes."
  - Interpretation, not stated: this applies to cacheable paths, for example a 404 for a deleted `/assets/*.js` chunk.
  - https://developers.cloudflare.com/cache/concepts/default-cache-behavior/
- Browser Cache TTL defaults to 4 hours on every plan. Cloudflare "overrides those headers" sent to the browser if the origin's value "is less than the Browser Cache TTL", or if the origin "does not send a `Cache-Control` or an `Expires` header".
  - "Respect Existing Headers" stops this.
  - "Purging Cloudflare's cache does not affect assets stored by a visitor's browser."
  - Also on the Cache-Control page: "Cloudflare respects whichever value is higher: the Browser Cache TTL in Cloudflare or the `max-age` header."
  - **Unconfirmed** whether the override applies to `no-cache`/`no-store`/`private` responses or to non-cached (HTML/JSON) paths.
  - https://developers.cloudflare.com/cache/how-to/edge-browser-cache-ttl/
- Compression to visitors: "Cloudflare supports Gzip, Brotli, and Zstandard compression when delivering content to website visitors".
  - Covered types include HTML, CSS, JS, JSON and SVG.
  - Only status 200, 403 or 404 is compressed.
  - Minimum size: 48 bytes for gzip, 50 bytes for Brotli/Zstd.
  - Default by plan: Free → Zstandard, Pro/Business → Brotli, Enterprise → Gzip. The visitor's `accept-encoding` still decides.
  - To the origin, Cloudflare sends `accept-encoding: br, gzip`.
  - The origin can opt out with `cache-control: no-transform`.
  - https://developers.cloudflare.com/speed/optimization/content/compression/

### 3. TanStack Query v5

The docs site at /query/latest labels the version "v5 Latest". https://tanstack.com/query/latest

- Important Defaults (https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults):
  - Queries "by default consider cached data as stale".
    - `staleTime: Infinity` means "never trigger a refetch until the Query is invalidated manually".
    - `'static'` means "never trigger a refetch, even if the Query is invalidated manually".
  - "Stale queries are refetched automatically in the background when: New instances of the query mount / The window is refocused / The network is reconnected".
  - `refetchInterval` "is independent of the staleTime setting".
  - "By default, 'inactive' queries are garbage collected after 5 minutes". The `gcTime` default is `5 * 60 * 1000`.
  - "Queries that fail are silently retried 3 times, with exponential backoff delay before capturing and displaying an error to the UI."
  - Results are "structurally shared", so a data reference is unchanged when the data is unchanged.
- useQuery reference (https://tanstack.com/query/latest/docs/framework/react/reference/useQuery):
  - `staleTime` defaults to `0`.
  - `gcTime`: "Defaults to 5 * 60 * 1000 (5 minutes), or Infinity during SSR".
  - `retry`: "Defaults to 3 on the client and 0 on the server".
  - `retryDelay`: "Defaults to a function that applies exponential backoff, capped at 30 seconds".
  - `refetchInterval` defaults to `false`.
  - `refetchIntervalInBackground` defaults to `false`: "If set to true, the query will continue to refetch while their tab/window is in the background".
  - `refetchOnWindowFocus` and `refetchOnMount` default to `true`, and refetch only "if the data is stale". `'always'` refetches regardless, except with `staleTime: 'static'`.
- Retries guide: "The default `retryDelay` is set to double (starting at `1000`ms) with each attempt, but not exceed 30 seconds". Code: `retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000)`. https://tanstack.com/query/latest/docs/framework/react/guides/query-retries
- Mutations: "By default, TanStack Query will not retry a mutation on error, but it is possible with the retry option". https://tanstack.com/query/latest/docs/framework/react/guides/mutations
- Invalidation (https://tanstack.com/query/latest/docs/framework/react/guides/query-invalidation):
  - The query "is marked as stale. This stale state overrides any `staleTime` configurations". If it is currently rendered "it will also be refetched in the background".
  - Prefix matching: `invalidateQueries({ queryKey: ['todos'] })` matches `['todos']` and `['todos', { page: 1 }]`. `exact: true` limits it to `['todos']`.
- `invalidateQueries` and `refetchType` (https://tanstack.com/query/latest/docs/reference/QueryClient):
  - "Unless `filters.refetchType` is `'none'`, matching queries are then refetched … using `filters.refetchType` if set, otherwise `filters.type`, otherwise `'active'`".
  - The promise resolves "immediately if `refetchType` is `'none'`".
  - Options are passed to `refetchQueries`, whose default `cancelRefetch: true` cancels a running fetch first.
  - The filter `type` is `'active' | 'inactive' | 'all'` ("Defaults to all"): https://tanstack.com/query/latest/docs/framework/react/guides/filters
  - So in practice: invalidating marks every matching query stale but refetches only active ones; inactive ones refetch when next used.
- Prefetching (https://tanstack.com/query/latest/docs/framework/react/guides/prefetching):
  - The current docs prefetch with `query()`, which "uses the default staleTime configured for the queryClient to determine whether existing data in the cache is fresh". A per-call `staleTime` "is only used for that query fetch".
  - "If no instances of useQuery appear for a prefetched query, it will be deleted and garbage collected after the time specified in gcTime".
  - The reference marks `prefetchQuery`/`fetchQuery` as deprecated in favour of `query()`; `fetchQuery` returns cached data "if it isn't stale". https://tanstack.com/query/latest/docs/reference/QueryClient
- placeholderData and keepPreviousData:
  - Placeholder data is like `initialData` "but the data is not persisted to the cache". The query starts in `success` with `isPlaceholderData: true`. https://tanstack.com/query/latest/docs/framework/react/guides/placeholder-query-data
  - With `placeholderData: keepPreviousData` (or `(previousData) => previousData`), "The data from the last successful fetch is available while new data is being requested, even though the query key has changed". https://tanstack.com/query/latest/docs/framework/react/guides/paginated-queries
- Window focus: the default focus handler listens to `visibilitychange` and treats `document.visibilityState === 'visible'` as focus. https://tanstack.com/query/latest/docs/framework/react/guides/window-focus-refetching

### 4. Vite

- Build output: referenced assets "will get hashed file names". Public-dir files keep their names "(without hashing)". https://vite.dev/guide/assets
- The build guide describes deploying "The generated hashed assets (JS, CSS, and other file types like images)" separately "to use different cache strategies". https://vite.dev/guide/build
- `build.assetsDir` defaults to `assets`. https://vite.dev/config/build-options
- **Unconfirmed** on vite.dev: that the hash is derived from file content. The pages only say "hashed".
- Load Error Handling (https://vite.dev/guide/build):
  - "Vite emits `vite:preloadError` event when it fails to load dynamic imports. `event.payload` contains the original import error. **If you call `event.preventDefault()`, the error will not be thrown.**"
  - Example handler: `window.addEventListener('vite:preloadError', (event) => { window.location.reload() })`.
  - On deploys: "the hosting service may delete the assets from previous deployments … the code tries to import the corresponding old chunk, which is deleted. This event is useful for addressing this situation. In this case, make sure to set `Cache-Control: no-cache` on the HTML file, otherwise the old assets will be still referenced."
  - Retries: "Older browsers require a page reload because they cache the failure in the module map." Browsers with retriable module loading can retry the import.

### 5. Compression

- `Accept-Encoding` lists the encodings the client understands. The server picks one through content negotiation and names it in `Content-Encoding`.
  - The server "must never return a 406" unless `identity;q=0` or `*;q=0` forbids uncompressed content.
  - https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Accept-Encoding
- `Content-Encoding` values include `gzip`, `br` and `zstd`. When present, `Content-Length` refers to the encoded body. https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Encoding
- "the server must send a Vary header containing at least Accept-Encoding alongside this header in the response; that way, caches will be able to cache the different representations of the resource". https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Compression

