# 07 — Provider Directory and Gateway Key scope targeting Provider IDs

**What to build:** The Owner can issue a Gateway Key whose Key Scope lists Provider IDs; the Provider Directory returns Providers (not Provider Connections); the `/v1/models` endpoint and the Directory agree on Provider IDs.

**Blocked by:** 02 — Renamed ProviderRegistry with per-key base URL behavior and audit vocabulary update.

**Status:** ready-for-agent

- [ ] The Provider Directory response lists Providers (renamed from Provider Connections).
- [ ] Gateway Key scope accepts and validates Provider IDs in place of Connection IDs.
- [ ] The directory response and `/v1/models` agree on Provider IDs.
- [ ] Gateway Key tests pass on both dialects, including scope validation that rejects unknown IDs.