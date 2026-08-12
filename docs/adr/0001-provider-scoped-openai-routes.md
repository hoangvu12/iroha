# Provider-scoped OpenAI routes preserve exact model IDs

Iroha exposes `/providers/{connection_id}/v1/*` and forwards the request's exact upstream model ID unchanged. We rejected an unscoped router, custom provider headers, and provider-prefixed model aliases because model names collide across accounts and silent selection would make quality, capability, cost, and failure behavior ambiguous; the URL instead makes the hard-to-change client routing decision explicit.

