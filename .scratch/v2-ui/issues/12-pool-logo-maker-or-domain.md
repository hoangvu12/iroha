# 12: Pool logo from a maker or a website

**What to build:** On production the Owner typed `chatgpt.com` into a Pool's Logo field; the Pool stores it as `maker`, `/api/pools/gpt-6.1-sol/logo` answers 404, and the tile shows a letter (`/api/logos?maker=openai` and `?domain=chatgpt.com` both work). Backend: a Pool's logo accepts either a maker (`openai`) or a website (`chatgpt.com`, or a URL read for its host): a value with a dot is a domain, looked up like a Provider's `logo_domain`; keep `maker_guessed` behaviour for an empty value. Update the API, OpenAPI, skill text ("Logos and the overview") and tests. UI: the Pool Logo field (and the Provider one, for consistency) previews the logo it finds as you type, debounced, and says inline when none was found, before saving.

**Blocked by:** 01

**Status:** done

Spec story: 14.

- [x] A Pool with logo `chatgpt.com` and one with `openai` both serve a logo
- [x] The field previews and reports "no logo found" before saving

## Comments

**Built (test-first, with the `tdd` skill; seams: the admin HTTP API through testkit, and the Settings tabs through Testing Library + the UI SDK agent).**

- Backend (`internal/logos`, `internal/pools`): `logos.ReadPoolLogo` reads what the Owner typed: a value with a dot or a slash is a website (`NormalizeDomain`: a URL is read for its host, IPs/ports/credentials/single labels refused), anything else a maker ID (lower-cased; dots no longer allowed in maker IDs). `Service.Pool` serves a website's favicon like a Provider's logo domain, else the maker's mark as before. `PATCH/POST /api/pools` store the read value in `maker` (still the API field; `""` still guesses, `maker_guessed` unchanged). `GET /api/logos?maker=` takes the same values as the field, so the UI preview and the saved Pool agree. Refusals are a 400 with a hint naming both forms (`logos.PoolLogoError`). No migration: stored values keep their form (production's `chatgpt.com` now just works), and nothing the old check let in is refused at read time. OpenAPI docs (field docs, route summaries) and the skill (`29_logos_and_overview.md`, `29_model_pools.md`) updated. Test: `TestAPoolLogoIsAMakerOrAWebsite`.
- UI: `pages/providers/LogoField.tsx` (`LogoInput`) is the Logo field of both Settings tabs: tile + input, a debounced (400 ms) lookup through `findLogo` (`api/logos.ts`: GET the preview URL, 404 = none, other errors thrown), and a `role="status"` line the input is described by: "Looking for a logo…", "Logo found for X.", "No logo found for X. The tile shows a letter.", Iroha's 400 message (in red, input `aria-invalid`), or "Shows the first letter." (Provider `none` or nothing to guess). The tile keeps the last logo found while the next is looked up. Pool input is now labelled "Maker or website". `useDebounced` moved from `ProviderSettings.tsx` into `LogoField.tsx`. Tests: `LogoField.test.tsx` (agent test: set a website, see "no logo found" before any PATCH, save; debounced single lookup; refused value; Provider field incl. `none`).
- Checks: `go build/vet/test ./...` pass; `npm --prefix web run build` passes; web tests 25 passed. Headless Chrome (light, dark, 390 px) on a seeded testkit with fake logo sources: screenshots in `iroha-v2-notes/v2-ui/shots/12/` (found, typed miss, refused value on a phone, typed maker, Pools list, Provider field). Seeded `gpt-6.1-sol` with `chatgpt.com` serves its logo on the list and header.
- Not done: nothing deferred.
