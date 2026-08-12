# Iroha OpenAI capability matrix

Iroha exposes the OpenAI-compatible surface only under a Provider Connection scope. The exact model ID is forwarded unchanged. A connection's declared capabilities and the caller's Gateway Key scope can further restrict what is accepted.

| Surface | Operations | Streaming | Tools | Structured output | Cancellation | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Provider Directory | `GET /api/v1/directory/providers` | No | No | No | No | Authenticated with a Gateway Key and filtered by Key Scope. |
| Models | `GET /providers/{connection_id}/v1/models` | No | No | No | No | Exact model IDs allowed by the caller's Key Scope. |
| Chat Completions | `POST /providers/{connection_id}/v1/chat/completions` | Yes | Yes | Yes | Yes | Preserves supported and unknown JSON fields; returns OpenAI-shaped errors and a request ID. |
| Responses | `POST /providers/{connection_id}/v1/responses` | Yes | Yes | Yes | Yes | Preserves supported and unknown JSON fields; returns OpenAI-shaped errors and a request ID. |
| Errors | All inference errors | N/A | N/A | N/A | N/A | Stable Iroha codes, sanitized upstream context, and `x-iroha-request-id`. |

## Behavior by connection

- `chat`, `streaming`, `tools`, `structuredOutput`, and `responses` are declared per Provider Connection and can be overridden per catalog model.
- A model absent from the catalog is still forwarded unless Key Scope or an explicit exclusion forbids it.
- The Gateway Key is replaced by adapter-owned authentication before the request reaches the Provider.
- Cancellation and downstream disconnects abort the active upstream request.
- Retries stop once streamed bytes reach the caller.
- Unknown JSON fields are preserved at the passthrough boundary.

## Not part of the version-one surface

Embeddings, images, audio, moderation, files, batches, vector stores, and other OpenAI endpoints are not supported. No unscoped inference route or model alias is provided. Provider-specific transformation is limited to reviewed Inference Adapters; the UI cannot upload executable plugins.

## Conformance evidence

The repository exercises this surface with assembled Elysia HTTP tests and the official OpenAI JavaScript SDK. Tests cover non-streaming and streaming Chat Completions, non-streaming and streaming Responses, Models, tools, structured output, cancellation, unknown fields, OpenAI-shaped errors, and request metadata.
