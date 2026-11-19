# 16: Response and request normalisers for provider quirks

**What to build:** Provider quirks that rewrite content rather than classify failures, applied on passthrough and translated paths and on streams: `<think>` text moved into reasoning, non-standard content blocks flattened so messages are not empty, fields a Provider rejects on replayed turns dropped (such as Anthropic message IDs sent to OpenAI-shaped or Mistral Endpoints), streams ending without a finish reason closed cleanly. Every content-rewriting case in `docs/research/v1-case-catalog.md` is covered.

**Blocked by:** 13

**Status:** ready-for-agent

- [ ] Each normaliser has a test with a recorded upstream response or request
- [ ] Normalisers apply per Provider and are listed in the Provider summary
- [ ] Catalog content-rewriting cases all mapped
