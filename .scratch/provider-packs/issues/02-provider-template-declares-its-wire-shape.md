# 02 — The Provider Template declares its wire shape, and the Anthropic messages route honours it

**What to build:** The provider-scoped Anthropic messages surface decides whether to pass a caller's body through or translate it by comparing the Provider's Provider Template id against the literal brand string `anthropic`. The shipped Generic Anthropic-compatible Provider Template does not match that string, so a caller's Anthropic-shape body is translated into the OpenAI shape and sent to an upstream that speaks Anthropic. That surface is broken for exactly the Providers that Provider Template exists to serve.

Give the Provider Template a wire shape — the body shape its upstream speaks, either the OpenAI shape or the Anthropic shape — and have the route read it. The wire shape is Provider Template data read at request time; it is not persisted per Provider and it is not an Inference Adapter capability. See ADR-0020.

This is the only user-visible change in the feature.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Every built-in Provider Template declares a wire shape. The first-party Anthropic and Generic Anthropic-compatible templates declare the Anthropic shape; every other built-in declares the OpenAI shape.
- [ ] A Provider created from the Generic Anthropic-compatible Provider Template, called on the Anthropic messages surface, sends an Anthropic-shape body to its upstream. This test fails before the change.
- [ ] The same holds when the caller requests streaming: Anthropic SSE events pass through rather than being synthesised from OpenAI chunks.
- [ ] A Provider created from the first-party Anthropic Provider Template still passes through, streaming and non-streaming.
- [ ] A Provider on an OpenAI-shaped Provider Template still receives a translated OpenAI-shape body, and its caller still receives an Anthropic-shape answer and an Anthropic error envelope.
- [ ] A Provider with no Provider Template still reaches the Anthropic messages surface and is treated as the OpenAI shape.
- [ ] No Provider brand string remains anywhere in the HTTP layer.
- [ ] The chat completions and responses surfaces are unaffected for every Provider Template.
- [ ] No database migration is introduced.
