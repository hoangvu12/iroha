# 03 — HTTP inference routes renamed to Provider-scoped URLs with mixed-URL round-robin

**What to build:** Applications can call `/providers/{providerId}/v1/{chat.completions,responses,models}`; the Gateway picks an eligible Upstream Key round-robin and forwards to the key's resolved base URL; the old `/providers/{connectionId}/v1/...` URL returns 404.

**Blocked by:** 02 — Renamed ProviderRegistry with per-key base URL behavior and audit vocabulary update.

**Status:** ready-for-agent

- [ ] Inference route paths change from `/providers/:connectionId/v1/...` to `/providers/:providerId/v1/...`.
- [ ] The handler resolves Provider → eligible Upstream Keys → round-robin pick → resolved key base URL → upstream call.
- [ ] The old `/providers/:connectionId/v1/...` paths return 404 (no redirect).
- [ ] HTTP inference tests pass on both dialects, including a Provider with one key at its default URL and one key at its own override URL.
- [ ] Chat Completions, Responses, Models, retries, streaming, security, and round-robin test suites are updated for the new path and continue to pass.