# 34: Duplicate Endpoint URLs within a Provider

**What to build:** `POST /api/providers/{provider}/endpoints` accepts a second Endpoint with the same URL and Shape under another name (the name defaults to `default`), so re-running an import or a script with a different name duplicates the Endpoint and keys rotate over the same URL twice (catalog SCR-11; the key-side version, SCR-03, is already handled by matching keys by secret). Either refuse with 409 `endpoint_duplicate` and a hint naming the existing Endpoint, or, when no name is given, match the existing Endpoint by URL and Shape (create-or-update), as keys match by secret. Ticket 27's "re-running the import does not duplicate anything" depends on it.

**Blocked by:** none

**Status:** ready-for-agent

- [ ] Test in `internal/providers` (create, bulk, PATCH to a duplicate URL)
- [ ] Skill text for Endpoints updated
