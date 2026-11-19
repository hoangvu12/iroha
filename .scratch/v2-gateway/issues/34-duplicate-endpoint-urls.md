# 34: Duplicate Endpoint URLs within a Provider

**What to build:** `POST /api/providers/{provider}/endpoints` accepts a second Endpoint with the same URL and Shape under another name (the name defaults to `default`), so re-running an import or a script with a different name duplicates the Endpoint and keys rotate over the same URL twice (catalog SCR-11; the key-side version, SCR-03, is already handled by matching keys by secret). Either refuse with 409 `endpoint_duplicate` and a hint naming the existing Endpoint, or, when no name is given, match the existing Endpoint by URL and Shape (create-or-update), as keys match by secret. Ticket 27's "re-running the import does not duplicate anything" depends on it.

**Blocked by:** none

**Status:** done

- [x] Test in `internal/providers` (create, bulk, PATCH to a duplicate URL)
- [x] Skill text for Endpoints updated

## Comments

Both options, as keys do it: a create without a name (with `url` and `shape`) updates the Endpoint that already has that URL and Shape, else falls back to `default` as before; any write that would give two Endpoints of a Provider the same URL and Shape (create under another name, bulk item, `PATCH` of url or shape, revert of a delete) is 409 `endpoint_duplicate`, hint naming the holder. `checkURL` now lowercases scheme and host, and URLs compare after `checkURL` (so a trailing slash or `HTTPS://API...` is the same URL). The same URL in another Shape is allowed. No migration: rows stored before keep working, and the check is in Go over the Provider's Endpoints of that Shape. Test: `providers TestAnEndpointURLAndShapeIsHeldOnceWithinAProvider`; skill text in `20_gateway.md`.
