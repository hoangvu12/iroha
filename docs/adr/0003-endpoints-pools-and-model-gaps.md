# Endpoints, Model Pools and Model Gaps replace per-key routing configuration

v1 answered "can Upstream Key K serve model M?" from five overlapping sources (Gateway Key scope, catalog row provenance, per-key allow- and deny-lists, per-key discovered availability, per-key model rewrites), and ADRs 0023, 0029, 0030 and 0031 of v1 were each a precedence rule between two of them; the code even contradicted ADR-0023. v2 has no per-key model configuration at all. A Provider has Endpoints (one URL, one Shape, optional model renames), an Upstream Key may be restricted to some Endpoints, cross-Provider failover lives only in Model Pools, and which key cannot serve which model is learned at runtime as a Model Gap that expires after 24 hours or is cleared by a test, an edit, a refreshed model list or the Owner. Discovered per-key model lists only order keys, never exclude them, because providers such as DashScope under-report what a key can call.

## Consequences

- The first request for a model a key cannot serve costs one Attempt; after that the Model Gap skips it.
- A model that is not on a Provider's list is still forwarded unless the Provider is marked strict, so aggregator aliases and newly released models work without configuration.
- Models the Owner adds by hand are kept independently of discovery and are never removed by a refresh.
