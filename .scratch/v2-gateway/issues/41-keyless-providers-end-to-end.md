# 41: Keyless Providers work end to end with no fuss

**What to build:** Many Providers need no key and no auth header (self-hosted vLLM/Ollama, free relays). Ticket 09 made an empty-secret key or an Endpoint with auth style `none` send no credential, and a keyless 401 retry elsewhere instead of marking the key invalid. Still missing, raised by the Owner on 2026-11-19:

- A Provider whose Endpoints need no auth fails with `503 no_upstream_key` until the Owner adds an empty "keyless slot" by hand. Make a keyless Provider usable without that ceremony: either the planner plans one implicit keyless slot when the Provider holds no Upstream Keys and the Endpoint's auth style is `none` (decide how Key States and Model Gaps attach to it), or a keyless key is created automatically, or the UI and API make it one obvious step. Pick the simplest model that keeps "every key has one Key State" true, and record the decision in `docs/agents/architecture.md`.
- The UI has no clear way to add a keyless key or a keyless Provider (the add-keys dialog takes pasted secrets). Add the obvious path, following `.scratch/v2-gateway/design/v2-clean/` style (calm, one main button).
- Audit every path for keyless correctness and add a test where one is missing: Attempts with each auth style plus empty secret, empty-string vs absent static headers, key test, test chat (ticket 23), route preview, model discovery per Provider and per key, Pools with a keyless member, the v1 import of keyless v1 keys, the Provider summary and the Keys table display.

**Blocked by:** none

**Status:** done

- [x] A Provider with one `none`-auth Endpoint and no hand-made key serves a Caller end to end (test through the HTTP seam), and nothing upstream ever receives an auth header or query parameter
- [x] UI path to add a keyless Provider / key
- [x] Every path above has a keyless test or a note why it cannot differ

## Comments

- **Decision (in `docs/agents/architecture.md`, "Ticket 41"):** no implicit planner slot. Giving an Endpoint auth style `none` on a Provider with no Upstream Keys adds a real key `keyless` (empty secret) in the same Audit Entry (`EndpointResult.keyless_key`; one revert undoes both), so every key still has one Key State. Hand-made keyless keys (`{"name": ...}`) still work. The `no_upstream_key` hint now names the keyless path.
- **Behaviour change:** a static header with an empty value is no longer sent as `Name:`. It is dropped, and it removes the Caller's header of that name (Attempts, key tests, discovery).
- **UI:** "No key needed" switch in Add Provider; "Add keyless key" in the Keys empty state (per the design's EMPTY state) and in the Add keys dialog; keyless keys show "no secret"; toasts say when a keyless key was added. Checked in headless Chrome, desktop and phone.
- **Audit, each with a test:** every auth style plus empty secret, on Attempts and key tests (`gateway TestAKeylessKeySendsNothingInEveryAuthStyle`); empty vs absent static headers (`TestAnEmptyStaticHeaderIsNotSent`); the end-to-end Provider with chat, stream, key test and discovery, plus the Caller's credential in Bearer, `x-api-key` and `?key=` (`TestAKeylessProviderServesWithNoKeyAddedByHand`); route preview (`TestTheRoutePreviewShowsTheKeylessKey`); Pools with a keyless member, including failover after a keyless 401 (`TestAPoolWithAKeylessMember`); discovery per Provider (existing `models TestKeylessDiscoverySendsNoCredential`) and per key (`models TestPerKeyDiscoveryReadsAKeylessKeysListWithNoCredential`); v1 import (`v1import TestAnImportedKeylessProviderServesWithNoCredential`; imported Endpoints keep v1's auth style with keyless keys, which sends nothing); summary and overview counts (`keys.keyless`).
- **Test chat (23)** was not merged when this was done. It sends through the same gateway path, so the gateway tests above cover it.
- **Known limit:** the auto key is unrestricted. If a keyless Provider later gains keyed Endpoints, it is also tried there, sends nothing, and a 401 is `retry_elsewhere`. Restrict or delete it then.
