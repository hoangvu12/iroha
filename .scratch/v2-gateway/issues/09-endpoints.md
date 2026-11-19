# 09: Multiple Endpoints per Provider

**What to build:** A Provider can have several Endpoints, each with URL (including its version path), Shape, auth style (bearer, `x-api-key`, custom header, query parameter, none), static headers, and optional model renames applied per Attempt after the Endpoint is chosen. Upstream Keys can be restricted to some Endpoints; keys may have empty secrets for keyless Endpoints, which send no auth header. Candidate planning prefers Endpoints that speak the Caller's Shape (translation itself arrives in 13–15; until then only same-Shape Endpoints are candidates).

**Blocked by:** 05

**Status:** done

- [x] A key restricted to some Endpoints is never sent to others
- [x] Renames apply per Attempt, so failover to a differently named Endpoint sends the right wire model
- [x] Keyless Endpoints send no auth header; key test uses each auth style correctly
- [x] Endpoint changes write Audit Entries

## Comments

Implemented on `agent/t09`.

- Endpoint API: `auth_style` (`bearer` default, `x-api-key`, `header` + `auth_param`, `query` + `auth_param`, `none`), `static_headers`, `renames` on create/bulk/PATCH; maps replace the whole set. Validated in `providers.checkEndpoint` (header names, reserved transport headers, no static header in the auth slot, no control characters). The Endpoint snapshot carries the new fields (old Audit Entries restore as bearer, no headers, no renames).
- Restrictions: table `upstream_key_endpoints` (migration `09_01`); `"endpoints": [names or IDs]` on key create, bulk, PATCH (`[]` lifts it; pasting a known secret with `endpoints` restricts that key). Key snapshots hold sorted Endpoint IDs. Deleting an Endpoint removes it from keys' restrictions in the same Audit Entry (keys tracked, so revert restores both) and is refused with `409 endpoint_in_use` while a key may use that Endpoint alone; reverting an Endpoint's creation is refused while keys are restricted to it.
- Planner: `endpointTiers` returns tiers of Endpoints; `Plan` uses the first tier that yields a candidate, reporting only that tier's skips. Today there is one tier (same Shape). Ticket 13 only appends the other-Shape Endpoints as a second tier there. New skip reason `restricted`; `Key.Allows`, `Key.Keyless`, `Endpoint.WireModel`.
- Gateway: `outbound` applies every auth style; keyless Attempts (empty secret or style `none`) send no credential and drop a Caller header in the auth slot. A 401-type `invalid` verdict on a keyless Attempt becomes `retry_elsewhere` (v1 PRV-35), in the budget loop and the key test.
- Key test: runs on the first Endpoint the key may use or `?endpoint=`, in that Endpoint's Shape (`testCall`: Chat, Responses, Messages with `anthropic-version`, Gemini `:generateContent`) and auth style, with renames.
- Not done here: a dedicated bulk "restrict" action (bulk create-or-update by name already carries `endpoints`); discovery URLs per Endpoint (ticket 10).
