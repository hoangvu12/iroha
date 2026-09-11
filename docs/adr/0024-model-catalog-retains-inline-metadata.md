# Model Catalog retains inline Upstream Model metadata

Iroha retains an allow-listed subset of metadata returned by Provider model discovery and attaches it to the same exact Upstream Model ID. The retained fields are display name, context length, maximum input tokens, and maximum output tokens. They are emitted as `normalized_name`, `context_length`, `max_input_tokens`, and `max_output_tokens` on both provider-scoped and global Models surfaces. The global surface qualifies only `id`; metadata remains attached to that Qualified Model ID without changing its Upstream Model portion.

Provider fields are normalized generically while synchronizing the Model Catalog. Common flat field names, nested `limit` objects, and nested `top_provider` limits map into the same retained shape without selecting behavior by Provider or Provider Template. Malformed, zero, negative, unsafe, and unrelated upstream fields are ignored. A later successful discovery updates metadata it reports, while a discovery that omits metadata retains the last reported facts for a model that remains present.

We rejected deriving routing identities from canonical-model catalogs or removing Provider-owned prefixes. Such normalization is lossy for gateways, regional deployments, and aliases. Metadata never rewrites an inference request: exact model identity remains the Provider-defined `modelId`, and every character after the first slash of a Qualified Model ID remains the exact Upstream Model ID.

The additional response fields are compatible extensions to the OpenAI-shaped Models list. Clients that only understand the standard fields may ignore them; discovery clients that understand inline model metadata can consume them without trying to infer identity from a modified model name.
