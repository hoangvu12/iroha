# OpenRouter model ID round-trip

Research date: 2026-08-17. Sources are OpenRouter's official documentation and public API. This is a non-normative research note.

## Conclusion

OpenRouter uses qualified model slugs such as `openai/gpt-4` in requests and in `GET /api/v1/models`. For an ordinary direct request, its documented response also contains that qualified slug. It does **not**, however, promise to echo the request literally: aliases, routers, and fallbacks report the concrete model that actually served the request.

That is a useful precedent for Iroha's global API, but the namespaces differ. OpenRouter's first segment identifies the model author/catalog namespace; infrastructure-provider routing is a separate option. Iroha's proposed first segment identifies an owner-created Provider connection. Therefore an OpenRouter model routed through an Iroha Provider might legitimately be `pr_openrouter/openai/gpt-4o`. Iroha must split only on the first `/` and pass the full remainder upstream unchanged.

## Findings

### Request IDs

OpenRouter's normal request form is an author-qualified slug, for example `openai/gpt-4`. The chat-completions reference uses that exact value in `model`; provider selection is expressed separately in the `provider` object. OpenRouter also accepts non-concrete identifiers, including `~author/family-latest`, router IDs such as `openrouter/auto`, and variant suffixes such as `:nitro`. [Chat Completions API](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request), [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection), [latest-model resolution](https://openrouter.ai/docs/guides/routing/routers/latest-resolution)

### Model-list IDs

`GET /api/v1/models` returns qualified `id` values such as `openai/gpt-4`; its example also exposes `canonical_slug` with the same qualified form. Thus callers can generally copy a catalog `id` directly into an inference request. The catalog is discovery and metadata: it supplies names, pricing, context length, modalities, and supported parameters. [Models API](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties)

In Iroha terms, a "catalog model" is simply a model learned from a Provider's model-list endpoint and shown by Iroha's `/v1/models`. It is not necessarily an allow-list. Rejecting every exact model absent from the latest catalog snapshot could block a newly released or temporarily omitted upstream model even when the Gateway Key otherwise permits it.

### Non-streaming response IDs

For a direct `openai/gpt-4` chat request, OpenRouter's API reference shows `model: "openai/gpt-4"` in the response. More importantly, OpenRouter documents the semantic rule for resolving requests: a `~anthropic/claude-opus-latest` request returns the concrete serving model, for example `anthropic/claude-opus-4.8`, rather than echoing the alias. Router and fallback documentation follows the same "model actually used" rule. [Chat Completions API](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request), [latest-model response semantics](https://openrouter.ai/docs/guides/routing/routers/latest-resolution), [model fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks)

OpenRouter additionally distinguishes the two concepts in optional router metadata: top-level `model` names the serving model, while `openrouter_metadata.requested` records the slug or alias sent by the client. [Router metadata](https://openrouter.ai/docs/guides/features/router-metadata)

The Responses API accepts the same qualified model form (`openai/gpt-4o`). Its public reference describes the response `model` as the model used for the response, consistent with the chat rule. [Responses API](https://openrouter.ai/docs/api/api-reference/responses/create-responses)

### Streaming response IDs

OpenRouter's official streaming guide confirms that Chat Completions and Responses use their normal SSE chunk schemas, and its router-metadata guide says routing metadata is placed on the final streaming chunk. The public prose reviewed does not separately promise that every chunk's `model` is a literal echo of the request. The safest reading is that streaming follows the endpoint's serving-model semantics, while `openrouter_metadata.requested` is the explicit source for the original alias when enabled. [Streaming guide](https://openrouter.ai/docs/api/reference/streaming), [Router metadata](https://openrouter.ai/docs/guides/features/router-metadata)

## Implications for Iroha

1. `GET /v1/models` should expose `provider_id/upstream_model_id`; the Provider-scoped model endpoint should remain unchanged.
2. Parse a global request at the first `/` only. For example, `pr_openrouter/openai/gpt-4o` routes to Provider `pr_openrouter` with exact upstream model ID `openai/gpt-4o`.
3. Do not search Providers for an unqualified model. Reject it deterministically.
4. Catalog presence should control discovery, not authorization to attempt an exact, scope-permitted model. This preserves access to newly released models while still allowing `/v1/models` to lag safely.
5. On the global API, preserve the Iroha Provider prefix in non-streaming responses and streaming chunks. When upstream returns a model, prefer `provider_id/<upstream-returned-model>` because it preserves both Iroha routing identity and upstream alias/fallback resolution. If upstream omits `model`, fall back to the qualified requested value.
6. If Iroha deliberately has no aliasing, fallback, or model substitution of its own, echoing the requested qualified ID will usually equal the above. Treat that as a consequence, not the contract; defining the field as "actual upstream-reported model, qualified by Iroha Provider" avoids hiding future resolution behavior.

