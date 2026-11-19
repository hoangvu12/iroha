# 07: Built-in rules for every known provider quirk

**What to build:** Port every provider-quirk failure behaviour listed in `docs/research/v1-case-catalog.md` into built-in Failure Rules: DashScope entitlement and billing codes (splitting its two-meaning codes by message text), Z.ai quota codes where only chat-relevant limits count, Mistral billing 402 and per-model 429, Nous credit 404 read as billing, ModelScope email verification, DeepAI pool-spent and check-in refusals, OpenRouter, Anthropic overload, and the rest. Each rule has a test using a recorded upstream response.

**Blocked by:** 06

**Status:** ready-for-agent

- [ ] Every provider-quirk failure case in the catalog maps to a rule and a test, or is marked not applicable with a reason
- [ ] Streamed error bodies are classified the same as non-streamed ones
