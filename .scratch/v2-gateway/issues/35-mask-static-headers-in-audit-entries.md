# 35: Mask static header values in Audit Entries

**What to build:** An Endpoint's static headers may hold a fixed relay credential (auth style `none` plus an `Authorization` static header), but Endpoint Audit Entries show their values whole, unlike Upstream Key secrets, which are masked to their last four characters (catalog PRV-86). Set `Secrets: []string{"static_headers"}` on the Endpoint audit resource (`internal/providers/endpoints.go`) and teach `audit.mask` (`internal/audit/mutate.go`, strings only today) to mask each value of a map. Revert must still restore the whole values. ADR-0006 keeps secrets readable through their own resource, so this only concerns history views; confirm the Owner wants it.

**Blocked by:** none

**Status:** closed (won't do)

- [ ] `TestEndpointAuthHeadersAndRenamesAreValidatedAndAudited` (or a new test) asserts the entry's before/after lack the header value and revert restores it

## Comments

- Closed by the Owner (2026-11-19): not worth it; static header values stay visible in Audit Entries.
