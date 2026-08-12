# 03 — Generic Provider Connection with one encrypted Upstream Key

**What to build:** An Owner can configure and operate one custom OpenAI-compatible Provider Connection with a stable client identity and one securely stored Upstream Key.

**Blocked by:** 02 — Secure single-Owner lifecycle.

**Status:** ready-for-agent

- [ ] The Owner can create a connection with an immutable unique ID, editable display name, base URL, and one Upstream Key.
- [ ] The default form shows only required setup fields, with nonessential behavior reserved for later Advanced settings.
- [ ] Upstream Key material is encrypted with the installation master key and is never returned after submission.
- [ ] A new key is saved as Unverified, may run a low-cost mock validation, and retains a useful failure reason after inconclusive validation.
- [ ] The Owner can manually activate, retest, disable, and inspect the key.
- [ ] The Owner can edit, disable, archive, duplicate, and explicitly purge a Provider Connection without mutating its ID.
- [ ] Archive preserves historical identity and removes the connection from active use.
- [ ] Admin APIs are typed, Owner-session protected, and represented in generated OpenAPI output.
- [ ] Browser and HTTP tests prove the complete create/edit/test/archive flow and secret non-disclosure.

