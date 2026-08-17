# 03 — The Provider Registry resolves a Provider once per Request

**What to build:** Nothing hands a route the Inference Adapter a Provider should use. The inference path and the entitlement polling path each walk from the Provider's Provider Template id, through the Adapter Registry, to an adapter id, to an adapter — with their own separate fallbacks. Two callers can therefore disagree about which Inference Adapter one Provider uses, and the route compensates by reading Provider Template data itself.

Have the Provider Registry resolve a Provider once per Request, before Upstream Key selection, into a value carrying its Inference Adapter, its wire shape, its retry settings and its Provider Template id. Both paths consume that value. The route-local resolver and the usage service's private adapter lookup are removed rather than kept alongside.

The resolved value is implementation, not domain language — it is deliberately absent from the glossary, and no test should assert its shape.

This is a prefactor. No behaviour changes.

**Blocked by:** 02 — the wire shape must exist before the resolved value can carry it.

**Status:** ready-for-agent

- [ ] The Provider Registry exposes one resolution that produces a Provider's Inference Adapter, wire shape, retry settings and Provider Template id.
- [ ] Resolution happens once per Request, before an Upstream Key is selected, and is not repeated per Attempt.
- [ ] The Anthropic messages route reads the wire shape from the resolved value rather than looking up the Provider Template itself.
- [ ] The inference path and the entitlement polling path both resolve through it. Neither retains its own adapter lookup.
- [ ] A Provider whose stored Provider Template reference is absent resolves to the Generic OpenAI-compatible defaults. No caller carries a fallback branch for that case.
- [ ] Every behaviour asserted by ticket 02 still holds, verified through the existing assembled-app tests without editing them.
- [ ] Round-robin selection, Key Health, Capacity Evidence and Routing Eligibility are unchanged.
- [ ] No test asserts the shape of the resolved value.
