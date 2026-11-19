# 10: Model lists and discovery

**What to build:** Each Provider keeps a model list whose entries can be discovered (per Provider or per key, from each Endpoint's discovery URL, or never), added by the Owner, and hidden, independently. Discovery never removes Owner additions; failures keep the previous list. Per-key discovered lists order carriers first and never exclude keys, and a list that includes a model clears that key's Model Gap for it. Unlisted models are forwarded unless the Provider is strict. Agents can trigger a refresh and reset discovered models. Provider-scoped `/models` lists the Provider's visible models within the Gateway Key's scope.

**Blocked by:** 08, 09

**Status:** ready-for-agent

- [ ] Discovery accepts `data` or `models` arrays; failures are logged, not fatal
- [ ] Owner-added models survive refreshes that omit them
- [ ] Hidden models are refused and unlisted
- [ ] Strict Providers refuse unlisted models before any Attempt; others forward them
- [ ] Carriers ordered first; discovery clears matching Model Gaps
- [ ] Reset discovered models without recreating the Provider
