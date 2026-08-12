# 03 — Generic Provider Connection with one encrypted Upstream Key

**What to build:** An Owner can configure and operate one custom OpenAI-compatible Provider Connection with a stable client identity and one securely stored Upstream Key.

**Blocked by:** 02 — Secure single-Owner lifecycle.

**Status:** complete

- [x] The Owner can create a connection with an immutable unique ID, editable display name, base URL, and one Upstream Key.
- [x] The default form shows only required setup fields, with nonessential behavior reserved for later Advanced settings.
- [x] Upstream Key material is encrypted with the installation master key and is never returned after submission.
- [x] A new key is saved as Unverified, may run a low-cost mock validation, and retains a useful failure reason after inconclusive validation.
- [x] The Owner can manually activate, retest, disable, and inspect the key.
- [x] The Owner can edit, disable, archive, duplicate, and explicitly purge a Provider Connection without mutating its ID.
- [x] Archive preserves historical identity and removes the connection from active use.
- [x] Admin APIs are typed, Owner-session protected, and represented in generated OpenAPI output.
- [x] Browser and HTTP tests prove the complete create/edit/test/archive flow and secret non-disclosure.

## Comments

### What was built

- `src/crypto/` — `createSecretCipher`, an AES-256-GCM cipher keyed from
  `IROHA_MASTER_KEY` (SHA-256-normalised to 256 bits). Each encryption uses a
  fresh IV and the stored form is self-describing (`v1.<iv>.<tag+ciphertext>`);
  tampering and a changed master key are indistinguishable, value-free
  `SecretCipherError` failures.
- `src/persistence/` — `provider_connections` and `upstream_keys` on both
  dialects behind one `ProviderRepository`, with a new migration on each track.
  The key column stores only cipher output. A key's lifecycle field is named
  `health` to match `CONTEXT.md`'s Key Health term, and currently holds the
  pre-engine states `unverified`, `active`, `disabled`.
- `src/providers/` — `ProviderConnectionRegistry` owns the rules: IDs never
  change, keys are stored Unverified before they are tested, an inconclusive
  test keeps its reason, deletion is archive-first, and secrets never leave.
  `createGenericKeyProbe` is the low-cost adapter seam (generic
  `GET <base>/models` with the key as a bearer credential); the transport is
  injected at the composition boundary and tests drive a fake.
- `src/http/admin.ts` — `/api/v1/admin/provider-connections`: list, create,
  inspect, edit, archive, duplicate, purge, and the three key actions. Every
  route demands the Owner's session; every mutation also the session's CSRF
  token. Success responses are typed and appear in `/docs/json`.
- `src/http/owner-guard.ts` — the session/CSRF guard extracted from `auth.ts`
  so administration and authentication share one rule.
- `ui/` — a Providers area: connection list with create/edit, an explicit
  insecure-HTTP exception and its persistent warning, key Test/Activate/Disable
  actions, archive-first Purge, and duplicate.

### Decisions worth knowing about

- **Deletion is archive-first.** A live connection cannot be purged; it must be
  archived (taken out of active use) first, and purge then refuses nothing but
  an already-archived connection. The UI hides Purge until a connection is
  archived, so the accidental-delete path the spec warns about is closed.
- **The key test is a seam, not a fixed call.** The generic probe reads the
  provider's models endpoint and classifies conservatively — only an explicit
  `401` rejects a key; every ambiguous answer keeps it Unverified with its
  reason. Real provider behaviour (and a per-provider adapter) lands with later
  tickets; the seam is already in place.
- **No request body schemas on the admin routes, same as auth.** Elysia's
  validation report quotes the offending value, and here that value can be an
  Upstream Key. Bodies are validated by the registry and errors return field
  rules only. Response schemas are declared.
- **The probe runs at creation and duplication, never on a paid endpoint.** It
  is a free `/models` call; a usable result activates an Unverified key on the
  spot, anything else leaves it Unverified with the reason recorded.
- **Key material is touched in memory only twice.** At submission (to encrypt)
  and during duplicate/test (to re-encrypt or hand to the probe). It is never
  returned by any endpoint, never written to audit, and never quoted in an
  error.

### Deferred to the tickets that own them

- Multiple Upstream Keys per connection and Upstream Accounts (ticket 09/…).
  The schema and registry hold one key per connection today; nothing exposes
  adding a second.
- Full Key Health states (Cooling Down, Invalid Authentication, Exhausted),
  capacity scopes, and cooldown recovery — ticket 10 owns the engine; this one
  ships only the durable `health` field and the three states it needs.
- Advanced settings (auth overrides, encrypted static headers, capabilities,
  redirects, timeouts, retries). The create form stays essential-only and these
  arrive under settings later.
- Provider Templates (ticket 15). Creation is custom/OpenAI-compatible only.

### Review

`/code-review` ran both axes over this work. Findings applied: the key
lifecycle field was renamed `status` → `health` to match the glossary, the
`credential` wording was replaced with the canonical term, purge was gated
behind archive-first per the spec, the duplicated probe-patch logic was
extracted, and the key-test seam's argument was renamed to `upstreamKey`.
