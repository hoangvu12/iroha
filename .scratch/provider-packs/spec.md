# Provider Packs

Status: Draft

## Problem Statement

Adding a Provider to Iroha costs wildly different amounts of work depending on the upstream, and the expensive case is expensive for no good reason.

An upstream that genuinely speaks the OpenAI shape costs one Provider Template entry. That part is fine and this spec does not touch it.

An upstream that needs typed behaviour — its own Failure Classification, or an authoritative entitlement endpoint — costs five source edits, two barrel exports, and five test edits. The three parts of one Provider (its Provider Template, its Inference Adapter, its Usage Adapter) live in different files and are rejoined only by adapter-id strings. Nothing structurally requires all of them to be present, so a step can be silently skipped: the test harness lists each typed Inference Adapter by hand and never listed the Z.ai one, so every assembled test for a Z.ai Provider reaches the real network instead of the stub upstream transport.

The same scattering has produced a live defect on the caller-facing surface. Because no resolved Provider carries its own Inference Adapter, the provider-scoped Anthropic messages route decides how to treat a caller's body by comparing the Provider Template ID against the literal brand string `anthropic`. The shipped Generic Anthropic-compatible Template does not match that string, so a caller's Anthropic-shape body is translated to the OpenAI shape and sent to an upstream that speaks Anthropic. That surface is broken for exactly the Providers the Template exists to serve.

## Solution

Two changes, in order.

**First, the Provider carries its own knowledge to the route.** The Provider Template gains a wire shape — the body shape its upstream speaks. The Provider Registry resolves each Provider once per Request, before Upstream Key selection, into a value carrying that wire shape, the Provider's Inference Adapter, and its retry settings. The Anthropic messages route reads the wire shape instead of comparing brand strings, so an Anthropic-shaped Provider passes its caller's body through whichever Provider Template seeded it. No brand string remains anywhere in the HTTP layer.

**Second, one Provider becomes one module.** A Provider Pack is Iroha's complete built-in knowledge of one upstream brand: one Provider Template, one Inference Adapter, one Usage Adapter. Packs are declared one per brand and registered as a list. The adapter-id constants, the barrel exports, the registry wiring and the hand-written test overrides all disappear, because a Pack holds its adapters directly rather than naming them by string.

Adding a typed Provider then costs one new Pack module, one line in the Pack list, and whatever adapter behaviour the upstream genuinely needs.

## User Stories

1. As an Owner, I want to create a Provider from the Generic Anthropic-compatible Provider Template and call the Anthropic messages surface, so that my Anthropic-shaped upstream receives the body shape it understands.
2. As an Owner, I want an Anthropic-shaped proxy behind a custom base URL to work on the Anthropic messages surface, so that I am not forced onto the first-party Anthropic Provider Template to get correct behaviour.
3. As an Owner, I want the Anthropic messages surface to keep passing bodies through unchanged for a first-party Anthropic Provider, so that this change does not regress what already works.
4. As an Owner, I want the Anthropic messages surface to keep translating for an OpenAI-shaped Provider, so that the bidirectional promise of that route still holds.
5. As an Owner, I want every Provider I have already created to keep working without action from me, so that upgrading Iroha is not a migration exercise.
6. As an Owner, I want a Provider I built by hand with no Provider Template to keep routing inference, so that the unusual case is never abandoned.
7. As an Owner, I want the Provider Directory, the model catalog and the Provider Logo to behave exactly as before, so that this work is invisible to my applications.
8. As an Owner, I want my Gateway Keys, Key Scopes and Qualified Model IDs to be unaffected, so that no application I run needs reconfiguring.
9. As an Owner, I want Key Health, Capacity Evidence and Routing Eligibility to be derived exactly as before, so that round-robin behaviour does not change under me.
10. As an Owner, I want the management UI's Provider Template picker to show the same Provider Templates in the same order, so that creating a Provider feels unchanged.
11. As an Owner, I want the Provider Template picker to keep showing each brand's description, base URL, capability defaults and known models, so that I keep the setup help I rely on.
12. As a caller, I want my Anthropic SDK to work against a Provider whose upstream speaks the Anthropic shape, so that I do not need to know which Provider Template the Owner picked.
13. As a caller, I want streaming on the Anthropic messages surface to behave identically for passthrough and translated Providers, so that event timing and shape stay predictable.
14. As a caller, I want an error on the Anthropic messages surface to keep arriving in the Anthropic error envelope, so that my SDK's error handling still works.
15. As a maintainer, I want one Provider's Provider Template, Inference Adapter and Usage Adapter declared in one module, so that I can read a Provider's whole behaviour in one place.
16. As a maintainer, I want to add a typed Provider by writing one Pack module and adding one line to the Pack list, so that I cannot forget a wiring step.
17. As a maintainer, I want to delete a Provider by deleting its Pack module and its list entry, so that no dangling adapter ids or exports survive.
18. As a maintainer, I want a Pack to reference its Inference Adapter directly rather than by string id, so that a Pack naming a missing adapter is unrepresentable rather than caught at startup.
19. As a maintainer, I want the test harness to inject the stub upstream transport into every Pack generically, so that no Provider can silently escape to the real network.
20. As a maintainer, I want a test that fails if any built-in Pack's adapters are not the injected ones, so that the Z.ai class of defect cannot recur.
21. As a maintainer, I want the HTTP layer to contain no Provider brand strings, so that a new brand never requires a route edit.
22. As a maintainer, I want one place that resolves a Provider's Inference Adapter, so that two callers can never disagree about which adapter a Provider uses.
23. As a maintainer, I want a Provider with no Provider Template to resolve to the Generic OpenAI-compatible Pack, so that no caller needs its own fallback branch.
24. As a maintainer, I want a Pack's id to be the Provider Template id it carries, so that no database migration is required.
25. As a maintainer, I want the entitlement polling path and the inference path to resolve a Provider's adapters through the same mechanism, so that they cannot drift apart.
26. As a maintainer, I want the wire shape declared as Provider Template data rather than on the Inference Adapter contract, so that ADR-0010 stands and no adapter must declare which caller shapes it accepts.
27. As a maintainer, I want the Provider Template to remain data with no executable configuration, so that ADR-0004 stands.
28. As an agent working in this codebase, I want a Provider's declaration to be in a predictable location, so that I can find and extend it without searching six files.
29. As an agent working in this codebase, I want adapter code to always live beside its Pack rather than sometimes inside it, so that I never have to guess where a Provider's behaviour is.
30. As a maintainer, I want the built-in Pack list to be the single source of truth for which Providers Iroha knows, so that documentation and tests can enumerate it directly.
31. As a maintainer, I want the existing test suites to keep passing with edits only where they enumerate Providers by hand, so that the move is verifiably behaviour-preserving.

## Implementation Decisions

**Provider Pack.** A new term in the domain glossary, recorded in ADR-0019. A Provider Pack is Iroha's complete built-in knowledge of one upstream brand: one Provider Template, one Inference Adapter, one Usage Adapter. Packs are declaration only — a Pack holds its Provider Template as data and references its adapter factories. Adapter behaviour always lives in its own module beside the Pack, never inside it, regardless of size. This is a deliberate rule with no size exception, so the location of a Provider's behaviour is always predictable.

**Pack identity.** A Pack's id is the Provider Template id it carries. The Provider Template no longer needs an id of its own. The persisted template reference on a Provider therefore keeps working unchanged and no migration is required.

**Pack registration.** The built-in Packs are a list. The Adapter Registry is constructed from that list rather than from two id-keyed maps plus a separately supplied Provider Template collection.

**Adapter ids are removed.** Because a Pack holds its adapters directly, the adapter-id constants, their barrel re-exports, and the Adapter Registry's validation that a Provider Template names a registered adapter all go away. That validation is removed rather than reimplemented: the error it catches becomes unrepresentable.

**Test-mode construction.** The Adapter Registry's per-adapter override options are replaced by a single mechanism that applies an injected upstream transport to every Pack's adapters uniformly. Adding a Pack cannot require a new override field.

**Wire shape.** The Provider Template gains a wire shape field with two values: the OpenAI shape and the Anthropic shape. It describes the body shape the upstream speaks. It is read from the Provider Template at request time and is not persisted per Provider, so there is no schema change. It is not an Inference Adapter capability; ADR-0010 stands and is not superseded. Recorded in ADR-0020.

**Provider Template capability defaults are unchanged.** The wire shape is separate from the existing capability claims and does not replace or duplicate them.

**Resolved Provider.** The Provider Registry gains a resolution step that produces, once per Request and before Upstream Key selection, a value carrying the Provider's Inference Adapter, its wire shape, its retry settings and its Pack id. The type is implementation, not domain language, and is deliberately absent from the glossary. Both the inference path and the entitlement polling path resolve through it, so they cannot diverge.

**Adapter resolution has one implementation.** The route-local adapter resolution helper and the usage service's private adapter lookup are both removed in favour of the Provider Registry's resolution. A Provider whose persisted Provider Template reference is null resolves to the Generic OpenAI-compatible Pack, so no caller carries a fallback branch.

**The Anthropic messages route.** It reads the resolved Provider's wire shape to decide passthrough versus translation. All brand string comparison is removed from the HTTP layer.

**Order of work.** The wire shape and resolved Provider land first and are independently shippable. Provider Packs land second. The first change is what gives Packs somewhere to attach; shipping Packs first would leave the route still deciding by Provider Template id.

## Testing Decisions

A good test here asserts externally observable behaviour: what the Gateway sends upstream, what it returns to the caller, and what durable state it writes. It does not assert how a Provider's Inference Adapter was located, which module a Provider Template lives in, or the shape of the resolved Provider value. The move from six files to one changes no behaviour, so most of its verification is that the existing suites still pass.

**Seam 1 — the assembled app with a stub upstream transport.** This is the existing highest seam and carries all behavioural verification. Tests drive real HTTP routes and inspect the recorded upstream calls. Prior art: the provider-scoped Anthropic messages tests and the assembled Provider Template tests under `test/http/`.

Cases at this seam:

- A Provider created from the Generic Anthropic-compatible Provider Template, called on the Anthropic messages surface, sends an Anthropic-shape body upstream. This is the regression test for the defect and must fail before the change.
- The same, streaming: Anthropic SSE events pass through rather than being synthesised from OpenAI chunks.
- A first-party Anthropic Provider still passes through, non-streaming and streaming.
- An OpenAI-shaped Provider still receives a translated OpenAI-shape body and its caller still receives an Anthropic-shape answer and an Anthropic error envelope.
- A Provider with no Provider Template reference still routes inference successfully.
- Chat completions and responses surfaces are unaffected for every Provider Template.

**Seam 2 — the built-in Pack list.** One structural suite iterates every Pack and asserts its Provider Template fields, that its Inference Adapter and Usage Adapter resolve, and that under test construction every Pack's adapters are the injected ones. This last assertion is the one that would have caught Z.ai escaping the stub transport, and it replaces the hand-written override list. Prior art: the existing Provider Template and Adapter Registry suites under `test/providers/`.

**No new seam on the resolved Provider.** Its behaviour is observable at seam 1, and testing it directly would bind tests to a shape this spec deliberately leaves free to change.

**Existing suites that must be edited, and only these.** The suites that enumerate Providers by hand — the Provider Template assertions, the assembled Provider Template route assertions, and the Adapter Registry construction assertions — are rewritten to iterate the Pack list rather than to branch per brand. Every other suite must pass unedited; an edit to any other suite is a signal that behaviour changed and should be treated as a defect in the change, not in the test.

## Out of Scope

**The Anthropic messages surface's Failure Classification.** On that route the translating Inference Adapter classifies upstream failures, so a Z.ai or MiniMax Provider's typed Failure Classification does not run there and its Key Health is not updated from that traffic. Fixing it requires the translating adapter to classify with the Provider's own error table before translating the error envelope. Deliberately deferred to keep this work shippable; recorded in ADR-0020.

**Failure Classification as a declarative table.** The typed Inference Adapters each reimplement error-envelope parsing, bounded field guards, Provider Diagnostics assembly and Capacity Evidence construction around what is a code-to-meaning table. Consolidating that is a separate change and does not block Packs.

**A shared entitlement probe.** Each typed Usage Adapter hand-rolls its own upstream call, cancellation handling, status mapping and body parsing. Consolidating that behind one module is a separate change.

**Credential Evidence honouring the Provider's authentication.** The Upstream Key probe always sends a bearer token and always reads the models endpoint, ignoring the authentication a Provider Template declares. It has no per-Provider seam at all. A Pack is the natural home for one, but adding it here would widen this work.

**An Owner override for the wire shape.** Both proxy cases select a Provider Template that already declares the right wire shape, and no Owner has asked for the override. It would need a new column and a migration. Add it when there is evidence.

**Any database migration.** A Pack's id is the Provider Template id, so nothing persisted changes.

**Pricing.** Iroha's Usage Adapter reads a Provider's own authoritative entitlement API. It is not a price table and this work does not introduce one.

**Any change to the management UI.** The UI is already driven entirely by the Provider Template API and contains no brand strings, adapter ids, or hardcoded colours.

## Further Notes

The naming survey behind Provider Pack is recorded at `docs/research/gateway-provider-module-naming.md`. Eleven production gateways and SDKs were read at source. Every one of them calls the module a "provider", which Iroha cannot reuse — Iroha's Provider is the Owner-created instance, while every other project uses the word for the vendor. "Kind" is spent by Kubernetes and inherited by the CRD-based gateways. "Definition" is spent by models.dev and Helicone on the per-model record. "Plugin" and "integration" are spent by Bifrost on middleware and on the inbound protocol surface respectively. "Pack" is unused across all eleven, and its nearest prior meaning — StackStorm's unit of deployment for integrations, organised around service boundaries — is the intended one.

That survey also found that no surveyed project has an equivalent of Iroha's Usage Adapter. Others move token-price tables out of the provider module; Iroha's Usage Adapter is a client for one vendor's own quota API, which is vendor knowledge and belongs inside the Pack. The divergence is deliberate.

The overload of "Provider" was considered and accepted. In the compound "Provider Pack" the word carries the vendor sense; alone it carries the Owner-created instance sense. The glossary already rules out "Vendor", and "Brand" is spent on Provider Logo, so a rename has nowhere good to go.
