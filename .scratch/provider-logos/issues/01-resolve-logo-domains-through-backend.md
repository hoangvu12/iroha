# 01 — Resolve Logo Domains through the backend

**What to build:** Give the Owner UI one backend-mediated way to resolve a Provider Logo from an exact Logo Domain, without exposing the logo.dev token or making logo-service requests directly from the browser.

**Blocked by:** None — can start immediately.

**Status:** complete

- [x] An authenticated Owner request can resolve a valid normalized hostname for light or dark theme.
- [x] Resolution tries logo.dev first when configured, then Google favicon for the same exact hostname, and reports not found when neither resolves.
- [x] Without a logo.dev token, resolution starts with Google favicon.
- [x] Resolution never contacts the Provider hostname and never retries a parent or registrable domain.
- [x] Successful images and short-lived misses are cached by normalized hostname and theme with the existing browser cache behavior preserved.
- [x] Invalid domains, unsupported themes, and unauthenticated requests return the repository's standard bounded errors.
- [x] The existing template-based logo endpoint remains compatible and shares the same resolution service.
- [x] Focused service and HTTP tests cover fallback order, token absence, cache identity, negative caching, authentication, validation, and legacy compatibility without real external calls.
