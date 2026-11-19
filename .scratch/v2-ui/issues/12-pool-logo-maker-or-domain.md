# 12: Pool logo from a maker or a website

**What to build:** On production the Owner typed `chatgpt.com` into a Pool's Logo field; the Pool stores it as `maker`, `/api/pools/gpt-6.1-sol/logo` answers 404, and the tile shows a letter (`/api/logos?maker=openai` and `?domain=chatgpt.com` both work). Backend: a Pool's logo accepts either a maker (`openai`) or a website (`chatgpt.com`, or a URL read for its host): a value with a dot is a domain, looked up like a Provider's `logo_domain`; keep `maker_guessed` behaviour for an empty value. Update the API, OpenAPI, skill text ("Logos and the overview") and tests. UI: the Pool Logo field (and the Provider one, for consistency) previews the logo it finds as you type, debounced, and says inline when none was found, before saving.

**Blocked by:** 01

**Status:** open

Spec story: 14.

- [ ] A Pool with logo `chatgpt.com` and one with `openai` both serve a logo
- [ ] The field previews and reports "no logo found" before saving
