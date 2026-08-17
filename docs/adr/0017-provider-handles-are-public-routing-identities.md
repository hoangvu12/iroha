# Provider Handles are immutable public routing identities

Iroha selects Providers in Qualified Model IDs and provider-scoped inference URLs with a globally unique, owner-chosen Provider Handle while retaining the generated Provider ID as its internal relational and historical identity. Handles make caller configuration readable without introducing model aliases or changing Gateway Key scope identity; because copied URLs and model IDs depend on them, a Handle is required at creation, can never be renamed, and remains reserved while its Provider record exists.

This supersedes ADR-0016 only where it requires an immutable Provider ID as the public Qualified Model ID prefix, and ADR-0001 only where its provider-scoped examples use an internal ID. Global and provider-scoped routing remain deterministic, the exact Upstream Model suffix remains unchanged, and Iroha never searches across Providers.

We rejected using the editable display name because renames would silently break callers, exposing generated IDs because they make public configuration needlessly opaque, and using "alias" because Iroha reserves that language for model indirection. Management APIs, database relationships, Gateway Key scopes, audit records, and historical records continue to use the immutable Provider ID; application-facing directories expose both identities and build inference URLs with the Handle.
