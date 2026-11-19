# 24: Settings pages use the full page width; Requests counts open Requests

**What to build:**

1. **Full width.** The Owner wants every page to use the page width (the wide frame, about 1280 px, `app/PageBody.tsx`), not the readable column (`max-w-3xl`). Today the Gateway Key page, Provider and Pool Settings tabs and the Settings pages sit in a 768 px column while their header spans the frame, which leaves the right half empty. This replaces spec story 4's "forms and settings sit in a readable column" (Owner, 2026-11-20); "nothing stretches across a wide monitor" still holds. Make the rows read well at that width (label and description on the left, the control on the right with a sensible max width, so inputs don't become 900 px long); judge it in screenshots at 1280 and 1920. Login and Setup stay narrow (they are centred forms, not pages). Update the PageBody comment, spec story 4's note in architecture.md if any, and remove the `readable` width if nothing uses it.
2. **Requests counts are links.** On the Gateway Keys list, the "Requests, 24 h" number opens Requests filtered to that Gateway Key and the last 24 hours (`requestsHref` in `pages/gateway-keys/List.tsx:33` already exists; the Key page links it). The same on the Gateway Key sheet if it shows the count. A count of 0 can stay plain. The link has an accessible name ("Requests of caller-1, last 24 h"). If the filter by name breaks after a rename, filter by the key's ID if the Requests feed supports it.

**Blocked by:** none

**Status:** open

Owner request, 2026-11-20.

- [ ] Gateway Key page, Provider and Pool Settings, Settings pages fill the wide frame and read well at 1280 and 1920
- [ ] Requests 24 h counts open the filtered Requests feed; agent test
- [ ] Checked in headless Chrome, light, dark and phone width
