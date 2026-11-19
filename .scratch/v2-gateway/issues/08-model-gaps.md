# 08: Model Gaps

**What to build:** When a rule says a key cannot serve a model, Iroha records a Model Gap instead of changing the Key State, skips that key for that model, and retries elsewhere. Gaps expire after 25 hours and are cleared by a key test, a key edit, or by hand (clearing by discovery lands in 10). Gaps are visible per key and per Provider through the API.

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] A refused model creates a gap; the key keeps serving other models
- [ ] Expiry, test, edit and manual clearing each covered by a test using the injected clock
- [ ] Bulk clear of gaps for selected keys
- [ ] Gap creation and clearing are logged
