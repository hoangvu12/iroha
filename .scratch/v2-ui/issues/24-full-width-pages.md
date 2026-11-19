# 24: Settings pages use the full page width; Requests counts open Requests

**What to build:**

1. **Full width.** The Owner wants every page to use the page width (the wide frame, about 1280 px, `app/PageBody.tsx`), not the readable column (`max-w-3xl`). Today the Gateway Key page, Provider and Pool Settings tabs and the Settings pages sit in a 768 px column while their header spans the frame, which leaves the right half empty. This replaces spec story 4's "forms and settings sit in a readable column" (Owner, 2026-11-20); "nothing stretches across a wide monitor" still holds. Make the rows read well at that width (label and description on the left, the control on the right with a sensible max width, so inputs don't become 900 px long); judge it in screenshots at 1280 and 1920. Login and Setup stay narrow (they are centred forms, not pages). Update the PageBody comment, spec story 4's note in architecture.md if any, and remove the `readable` width if nothing uses it.
2. **Requests counts are links.** On the Gateway Keys list, the "Requests, 24 h" number opens Requests filtered to that Gateway Key and the last 24 hours (`requestsHref` in `pages/gateway-keys/List.tsx:33` already exists; the Key page links it). The same on the Gateway Key sheet if it shows the count. A count of 0 can stay plain. The link has an accessible name ("Requests of caller-1, last 24 h"). If the filter by name breaks after a rename, filter by the key's ID if the Requests feed supports it.

**Blocked by:** none

**Status:** done

Owner request, 2026-11-20.

- [x] Gateway Key page, Provider and Pool Settings, Settings pages fill the wide frame and read well at 1280 and 1920
- [x] Requests 24 h counts open the filtered Requests feed; agent test
- [x] Checked in headless Chrome, light, dark and phone width

## Comments

**Built**
- `PageBody` has one width, `wide`; `readable` is gone. The Gateway Key page, Provider and Pool Settings tabs and Settings → Sign-in now sit in the wide frame (they lost their inner `PageBody width="readable"`). Login/Setup keep their own 340 px centred column (`LoginLayout` no longer wraps it in `PageBody`). PageBody's comment, architecture.md's "Page widths" line and spec story 4 are updated; new subsection "UI ticket 24" in architecture.md.
- Rows at that width: `SettingsRow` (Provider/Pool Settings) and the key page's `Row` share one layout: title and hint on the left, the hint at `max-w-prose`; the control in a right-hand column `md:w-[min(420px,45%)]`, inputs filling it (420 px at most, previously 300 px on the key page). The key's secret and the base URL truncate within that column instead of a fixed 300 px.
- `RequestsCount` (`pages/gateway-keys/bits.tsx`): the count as a UI SDK Button rendered as a router Link (agents see it), named "Requests of <name>, last 24 h", with RecordLink's quiet underline; 0 stays plain. Used in the Gateway Keys list (replacing the plain Link + tooltip) and the Gateway Key sheet (which had its own inline link by name).
- **Rename:** filtering by name did break after a rename (old Requests keep the old `caller_name`, while `recent_requests` counts by key ID). `requestsHref` (moved to `bits.tsx`) now links `caller=<key ID>`, which `/api/requests` already accepts. The feed shows an ID caller as the key's name from `/api/requests/filters` (`callerName` in `Feed.tsx`: chip, Caller menu tick, no-results line), so no `gk_...` reaches the Owner. The chip shows the name the Requests carry (e.g. the earlier name).

**Test-first** (tdd skill; seams taken from the ticket, no Owner to confirm them in this run): failing tests first, then the code, one slice at a time: `List.test.tsx` (count link name and href by ID, 0 plain, agent presses it), `RecordSheets.test.tsx` (sheet link), `Feed.test.tsx` (ID caller reads as the name in the chip and the Caller menu). Layout is checked in the browser.

**Browser check** (headless Chrome, seeded testkit with a Gateway Key renamed after its Requests): `C:\Users\ADMIN\Desktop\nguyenvu\iroha-v2-notes\v2-ui\shots\24\` (plan.json, plan-sheet.json, shot24.mjs = shot.mjs with `width`/`full`). Key page, Provider and Pool Settings, Sign-in at 1280 and 1920, light and dark; key page, Provider Settings, Sign-in, Gateway Keys at 390 px; login at 1280. No sideways scroll; inputs 410 px at 1280. The renamed key's count (12) opens `/requests?caller=gk_...&range=24h` with all 12 Requests (by name it would show none); the sheet's count links the same.

**Noted, not changed**: `Feed.test.tsx` "the Owner switches the feed to numbered pages..." times out in some full runs under load (renders 100 rows, ~19 s); it passes alone 4/4, and base `v2-ui` fails it the same way (1 of 2 full runs), so it's a flake that was already there. `iroha-v2-notes/v2-ui/check-pages.mjs` still knows a `readable` width (harmless: no page reports it now).
