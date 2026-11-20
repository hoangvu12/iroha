# Prompt caching: follow what other gateways do

The Owner asked (2026-11-20) whether Iroha handles Providers' prompt caching well. The research is `docs/research/prompt-caching.md`; read its Summary, sections 1, 2.8, 3 and 5 before any ticket here. Short version: same-Shape passthrough keeps every caching field, but round-robin across Upstream Keys sends a conversation's turns to different keys (and so, for keys from different accounts, to cold caches), translation to Anthropic Messages adds no cache markers and drops the conversation fields, and cache writes aren't recorded, so none of this is visible.

The Owner chose (2026-11-20) to copy what CLIProxyAPI, LiteLLM, Bifrost, OmniRoute and OpenRouter do:

1. **Cache usage you can see** (ticket 01): record cache writes, read every Provider's cache fields, show a cached share per Provider, Upstream Key and model.
2. **Conversation affinity** (ticket 02): identify the conversation from what Callers already send (or a prefix hash), and order a Provider's keys for it by rendezvous hashing, so its turns land on the same key and fail over to a fixed second key. On by default for every Provider (Owner's decision), with a per-Provider off switch, and a one-week half/half experiment to measure it.
3. **Caching across Shapes** (ticket 03): add cache markers when translating to Anthropic Messages (on by default for Anthropic-shaped Endpoints, Owner's decision), carry conversation fields across Shapes, refuse Gemini `cachedContent` in translation.

Rules that hold for every ticket:
- Same-Shape passthrough stays byte-for-byte as today, except where a ticket says otherwise (none does).
- Nothing here may make a Request fail that succeeds today, except the Gemini `cachedContent` refusal in ticket 03 (it silently loses context today).
- Every new Request field, setting and route is in the served skill and OpenAPI; every behaviour has a Go test with `internal/testkit`; v1 conformance (`.scratch/v2-gateway/conformance.md`) rows touched are updated.
- Glossary terms (`GLOSSARY.md`): Upstream Key, Endpoint, Shape, Caller, Gateway Key, Cooling, Model Pool. Add a glossary entry for the conversation affinity term you settle on.
