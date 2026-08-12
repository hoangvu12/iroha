# 15 — Built-in Provider Templates and known adapters

**What to build:** Common Providers are quick to configure through reviewed templates and typed behavior while custom compatible Providers continue to use the generic path.

**Blocked by:** 06 — Model catalog and scoped Models API; 11 — Usage Adapter and entitlement visibility; 12 — Advanced Provider transport policy.

**Status:** ready-for-agent

- [ ] Provider Templates exist for Generic OpenAI-compatible, OpenAI, OpenRouter, MiniMax, and verified data-only compatible defaults informed by nyanis.
- [ ] Templates prefill safe endpoint, authentication, model, and capability defaults but never contain accounts or secrets.
- [ ] Providers that fit generic behavior use data-only templates rather than bespoke code.
- [ ] Typed Inference Adapters exist only where authentication, endpoints, capabilities, errors, or idempotency require behavior.
- [ ] Typed Usage Adapters exist only for documented balance or coding-plan/subscription endpoints and declare scope/freshness honestly.
- [ ] The UI labels unsupported entitlement polling as reactive-only Unknown rather than zero.
- [ ] Adapter registry validation rejects duplicate IDs and malformed declarations at startup.
- [ ] Deterministic mock tests cover every built-in template and adapter without real Provider credentials.

