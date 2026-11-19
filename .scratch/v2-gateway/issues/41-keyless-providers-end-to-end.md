# 41: Keyless Providers work end to end with no fuss

**What to build:** Many Providers need no key and no auth header (self-hosted vLLM/Ollama, free relays). Ticket 09 made an empty-secret key or an Endpoint with auth style `none` send no credential, and a keyless 401 retry elsewhere instead of marking the key invalid. Still missing, raised by the Owner on 2026-11-19:

- A Provider whose Endpoints need no auth fails with `503 no_upstream_key` until the Owner adds an empty "keyless slot" by hand. Make a keyless Provider usable without that ceremony: either the planner plans one implicit keyless slot when the Provider holds no Upstream Keys and the Endpoint's auth style is `none` (decide how Key States and Model Gaps attach to it), or a keyless key is created automatically, or the UI and API make it one obvious step. Pick the simplest model that keeps "every key has one Key State" true, and record the decision in `docs/agents/architecture.md`.
- The UI has no clear way to add a keyless key or a keyless Provider (the add-keys dialog takes pasted secrets). Add the obvious path, following `.scratch/v2-gateway/design/v2-clean/` style (calm, one main button).
- Audit every path for keyless correctness and add a test where one is missing: Attempts with each auth style plus empty secret, empty-string vs absent static headers, key test, test chat (ticket 23), route preview, model discovery per Provider and per key, Pools with a keyless member, the v1 import of keyless v1 keys, the Provider summary and the Keys table display.

**Blocked by:** none

**Status:** ready-for-agent

- [ ] A Provider with one `none`-auth Endpoint and no hand-made key serves a Caller end to end (test through the HTTP seam), and nothing upstream ever receives an auth header or query parameter
- [ ] UI path to add a keyless Provider / key
- [ ] Every path above has a keyless test or a note why it cannot differ
