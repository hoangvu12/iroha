# 05: Key States, generic Failure Rules and the Request budget

**What to build:** Failed Attempts are classified by a Failure Rule engine with the generic built-in rules (auth refusal → invalid; 429 → cooling key+model honouring `Retry-After`; 5xx and network → retry elsewhere; 400 → fail). Upstream Keys move between active, disabled, invalid and cooling (key or key+model, escalating to the key after 3 distinct models in 5 minutes), each with a recorded reason. Requests retry on other keys within the budget (3 Attempts, 61 s to first byte, per-Provider overrides, 96 s ceiling) and, when all fail, return an error listing each Attempt. Request detail shows each Attempt's matched rule and action plus a one-line summary.

**Blocked by:** 04

**Status:** done

- [x] Every key always reports exactly one Key State and its reason via the API
- [x] Invalid keys stay out until a test passes or the secret changes
- [x] Cooling defaults to 60 s doubling to 1 h; reset times from responses are honoured
- [x] An Attempt that used up its time is not replayed on the same key
- [x] No candidate left → immediate error distinguishing "never servable" from "cooling until T"
- [x] Failure bodies and headers stored on every failed Attempt
- [x] Provider summary endpoint: state counts and cooling-until times
- [x] Key test makes a tiny real chat call; enable/disable/test available singly and in bulk
- [x] Key State changes are logged events

## Comments

Implemented on `agent/t05`.

- Numbers follow the spec, not this ticket: 60 s to first byte (per-Provider `first_byte_seconds` 1..95), 95 s ceiling, `max_attempts` default 3 (1..10).
- `internal/rules` is the pure Failure Rule engine. Rules are data (`rules.Rule`); built-ins are entries in `rules/builtin.go`, so ticket 07 adds providers' rules there (scoped by `Provider` or `Host`, which are tried before global rules). Ticket 06's agent-managed rules plug in through `gateway.Options.Rules` (a `func() *rules.Set`; build it with `rules.Merge(owner, rules.Builtin)` so same-named Owner rules override built-ins).
- Outcomes: `invalid`, `cooling_key`, `cooling_key_model`, `model_gap`, `retry_elsewhere`, `fail_request`. `model_gap` today only takes the key out for the rest of the Request; ticket 08 records the gap (built-ins already map 403/404 naming a model to it).
- `internal/keystate` holds runtime Key States (`key_states`, `key_model_cooling`); Owner `disabled` is an audited column on `upstream_keys` (enable/disable singly and in bulk, revertible). A secret change resets the runtime state. Cooling: 60 s, doubling (up to 1 h) when refused again within 1 h of the last cooling ending; `Retry-After`/`Retry-After-Ms` or a rule's `reset` sources win (max 7 days); 3 distinct models within 5 minutes cool the whole key.
- Budget: one first-byte deadline per Request, so a timed-out Attempt ends the Request (504 `upstream_timeout`) and is never replayed. A 5xx key+Endpoint pair is replayed once, after all other candidates. Invalid, cooling and model-gap keys are out for the rest of the Request.
- Errors after every Attempt failed carry `details.attempts` and `details.summary`: `upstream_rejected` (upstream 4xx status, `fail_request`), 504 `upstream_timeout`, 503 `upstream_unavailable` + Retry-After (keys cooled), else 502 `upstream_failed`. An empty plan gives 503 `keys_cooling` (Retry-After, `details.until`) or 503 `no_candidate` with `details.reason` `no_usable_key`. Failures after the stream committed are ticket 17's.
- Key test: `POST /api/providers/{p}/keys/{k}/test` and `.../keys/bulk/test` (5 at a time, `dry_run`), chat call on the first OpenAI Chat Endpoint, model from `?model=` or the Provider's latest served model. Not recorded as a Request; logged as `key.test`.
- `GET /api/providers/{p}/summary`: counts per Key State, coolings with until times, `next_usable_at`, effective budget, last hour's Attempt failure rate.
- The Provider is recorded on the Request when the first Attempt starts (`Recorder.NoteProvider`), per ticket 19's note.
