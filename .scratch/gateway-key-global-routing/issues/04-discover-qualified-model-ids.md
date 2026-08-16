# 04 — Discover Qualified Model IDs through the global API

**What to build:** Let an application use global model discovery to enumerate only the Provider/model combinations its Gateway Key may access. The same narrow seam parses and authorizes Qualified Model IDs for later global inference without guessing a Provider or exposing the Owner's Provider inventory.

**Blocked by:** 01 — Create unrestricted Gateway Keys.

**Status:** complete

- [x] Authenticated `GET /v1/models` returns `<provider_id>/<model_id>` entries filtered by the calling key's all or selected access policy.
- [x] Qualified Model ID parsing splits at the first slash only, preserving every later slash as part of the exact Upstream Model ID.
- [x] Missing Provider segments, missing model segments, and unqualified IDs produce `400 invalid_model_id` without upstream traffic.
- [x] Nonexistent, inaccessible, archived, and disabled Providers produce the same sanitized `403 provider_not_allowed`; selected model denial produces `403 model_not_allowed`.
- [x] Catalog absence does not become an inference allow-list: an exact unknown model remains authorizable when policy and Owner exclusions permit it.
- [x] Provider-scoped Models and the authenticated Provider Directory retain their existing URLs, shapes, and exact upstream IDs.
- [x] Model discovery works through the official OpenAI client and assembled HTTP tests cover ordering, deduplication, access changes, privacy, and nested model IDs.

## Comments

- Added the conventional global `GET /v1/models` surface with deterministic Qualified Model ID ordering and deduplication. Discovery uses effective catalog membership while authorization remains independent of catalog presence.
- Added one shared Qualified Model ID parser/authorization seam for subsequent global inference tickets. It preserves nested model IDs and normalizes Provider inventory privacy failures without sending upstream traffic.
- Focused assembled HTTP, official OpenAI client, parser, provider-scoped compatibility, and catalog tests passed (22 tests), along with root/UI typechecks. PostgreSQL conformance was discovered but skipped because `IROHA_TEST_POSTGRES_URL` is not configured.
