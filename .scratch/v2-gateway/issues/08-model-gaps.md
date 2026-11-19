# 08: Model Gaps

**What to build:** When a rule says a key cannot serve a model, Iroha records a Model Gap instead of changing the Key State, skips that key for that model, and retries elsewhere. Gaps expire after 24 hours and are cleared by a key test, a key edit, or by hand (clearing by discovery lands in 10). Gaps are visible per key and per Provider through the API.

**Blocked by:** 05

**Status:** done

- [x] A refused model creates a gap; the key keeps serving other models
- [x] Expiry, test, edit and manual clearing each covered by a test using the injected clock
- [x] Bulk clear of gaps for selected keys
- [x] Gap creation and clearing are logged

## Comments

- The ticket said 25 hours; the spec and ADR-0003 say 24, so gaps last 24 hours (`keystate.GapLifetime`).
- Storage: `model_gaps` (migration `08_01`), one row per key and wire model, with reason, rule, Request, created and expiry. Code in `internal/keystate/gaps.go`; `Store.Fail` handles the `model_gap` outcome (Key State untouched) for Attempts and key tests.
- Planning: `planner.Key.ModelGaps`; a key with a live gap for the Endpoint's wire model is skipped (`SkipModelGap`). If every usable key has a gap, the plan is empty with `model_gap` and the Caller gets `404 model_unavailable` (with `details.until`) without an Attempt; if every Attempt of a Request was refused with `model_gap`, the Caller gets the same 404. Cooling wins over a gap when choosing the empty-plan reason.
- Expiry: expired gaps stop counting at once and are hidden from the API; their rows are deleted and logged `model_gap op=expired` the next time a Request plans over that Provider (no extra background job, per the spec's job list).
- Clearing: a passing key test clears every gap of the key (a refused test renews the gap); editing the key's name or secret clears its gaps (enable/disable does not); by hand with `POST /api/providers/{provider}/keys/{key}/clear-model-gaps` and `.../keys/bulk/clear-model-gaps` (both `?model=` and `dry_run`). Clearing by hand or by an edit is audited through a `model_gap` audit resource, so reverting the entry restores the gaps (the spec's "Undo through Audit revert"). Discovery (ticket 10) should call `keystate.ClearGaps(..., track nil)`.
- Visibility: `model_gaps` on every Upstream Key, `GET /api/providers/{provider}/model-gaps` (`?model=`, `?upstream_key=`), and `model_gaps` in the Provider summary. Skill text in `25_key_states.md` and `20_gateway.md`.
- Not done here: the UI (ticket 22) and the route preview's "Model Gap" skip reason (the planner already reports `SkipModelGap` for it).
