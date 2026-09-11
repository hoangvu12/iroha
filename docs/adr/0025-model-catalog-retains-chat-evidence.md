# Model Catalog retains chat evidence and provider-indexed metadata

Iroha retains explicit chat support and input/output modalities alongside token limits in each Model Catalog entry. Provider discovery may establish chat support through boolean capabilities, supported endpoint lists, or text-output generative capabilities. Evidence that only non-chat endpoints or non-text output are supported records chat as unsupported. Missing evidence remains unknown.

The Models surfaces emit the retained result as `chat: "ok"` or `chat: "unsupported"` and expose modalities under `architecture`. A per-model Owner `chat` override takes precedence over discovered and external metadata. This lets discovery clients include only proven chat models without guessing from model names.

Iroha supplements missing fields from both the canonical and provider-indexed models.dev catalogs. Each nested entry keeps the source provider in its lookup identity even when the upstream model ID already contains slashes. Catalogs remain separate during lookup and merge only after each source produces an unambiguous match, so duplicate aliases cannot overwrite one another and canonical facts keep precedence.

We rejected classifying every non-embedding model as chat-capable and rejected assigning guessed limits to unmatched models. Both choices turn absence of evidence into a false capability claim. Unknown metadata remains absent until a Provider, an unambiguous catalog entry, or the Owner establishes it.
