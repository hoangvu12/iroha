## Global routes

One base URL reaches every Provider a Gateway Key may use: `/v1/chat/completions` and `/v1/messages` (other Shapes' routes join them as they are added) take the model as `<provider handle>/<model ID>`, and `GET /v1/models` lists exactly those IDs.

- The model is split at the **first** slash; everything after it is the Provider's own model ID, slashes included: `openrouter/meta-llama/llama-3.3-70b` sends `meta-llama/llama-3.3-70b` to Provider `openrouter`. Endpoint renames then apply to that ID as on `/providers/<handle>/v1/...`.
- The answer's `model` field (every stream event that has one included) reads the qualified name the Caller sent. The Request records it as `model`; the ID sent upstream is the Attempt's `wire_model`.
- An unqualified model (`gpt-4o`, `/gpt-4o`, `acme/`) gets `400 invalid_model_id` with a hint. A Provider that does not exist, is disabled or archived, or is outside the key's scope gets the same `403 provider_not_allowed`; a model outside a key narrowed to some models of the Provider gets `403 model_not_allowed`, and a hidden model `404 model_not_found`. Gateway Key scopes name models without the handle, exactly as the Provider names them.
- `GET /v1/models` answers in the OpenAI list shape, sorted by Provider handle then model, each entry with `owned_by` (the handle) and the metadata of `GET /providers/<handle>/v1/models`. It is one read however many Providers and models there are.
