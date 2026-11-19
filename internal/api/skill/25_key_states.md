## Key States and Failure Rules

Every Upstream Key reports exactly one Key State with its reason in `GET /api/providers/<handle>/keys` (`state.state`, `state.reason`, `state.until`):

- `active`: usable.
- `disabled`: the Owner turned it off. `POST /api/providers/<handle>/keys/<key>/disable` and `/enable`, or `POST /api/providers/<handle>/keys/bulk/disable` / `bulk/enable` with `{"items": ["key-1", "uk_..."]}`. Both are audited and revertible.
- `invalid`: the Provider refused the key itself (a 401, or a 403 about the account). It stays out until a key test passes or its secret changes.
- `cooling`: the key is resting until `state.until`. A key can also cool for one model only; those are listed in `cooling_models` while the key stays `active` for other models.

**Cooling** lasts 60 seconds by default. When the same key (or key and model) is refused again within an hour of its last cooling ending, the cooling doubles, up to 1 hour. A reset time the Provider sends (`Retry-After`, `Retry-After-Ms`, or a field a Failure Rule names) wins over the default, up to 7 days. A key cooled for 3 different models within 5 minutes cools as a whole. A key goes back to `active` by itself when its cooling ends.

**Failure Rules** read every failed Attempt (status, error code, body, headers) and decide its outcome:

| Outcome | Meaning |
|---|---|
| `invalid` | The key is invalid. |
| `cooling_key` | The whole key cools (e.g. 402: out of credit). |
| `cooling_key_model` | The key cools for this model (e.g. 429). |
| `model_gap` | The key cannot serve this model: it gets a Model Gap (below) and another key is tried. |
| `retry_elsewhere` | Try the next candidate; the key is unchanged (5xx, network errors, timeouts). |
| `fail_request` | The Provider refused the request itself (other 4xx); it goes back to the Caller. |

The built-in rules are generic: 401 → invalid; 403 → model_gap when the body names a model, invalid when it talks about the account, otherwise cooling_key_model; 402 → cooling_key; 404 naming a model → model_gap; 429 → cooling_key_model; 408, 5xx, network and timeouts → retry_elsewhere; any other 4xx → fail_request. The rule an Attempt matched, its outcome and the action taken are on the Attempt in `GET /api/requests/<id>` and logged as `rule.match`; every Key State change is logged as `key.state`. Add, override or switch off rules through `/api/rules` (see "Managing Failure Rules").

**Request budget.** A Request makes at most 3 Attempts and must see a first byte within 60 seconds of arriving. A Provider can change both: `PATCH /api/providers/<handle>` `{"max_attempts": 1..10, "first_byte_seconds": 1..95}` (0 restores the default). A key refused as invalid or cooling is not tried again in the same Request; one refused a model (model cooling or model gap) is not sent that model again in it, but still serves another Endpoint or Pool member that sends a different model; a key and Endpoint that answered 5xx may be tried once more, after every other candidate. An Attempt that ran out of time ends the Request with `504 upstream_timeout`; it is never replayed.

**Model Gaps.** When a Provider refuses one key one model (outcome `model_gap`, e.g. a 404 `model_not_found` or a 403 naming the model), the key keeps its Key State and serves its other models; only that model (as sent upstream) is no longer sent to it. Each key lists its gaps in `model_gaps` (`model`, `reason`, `rule`, `request_id`, `created_at`, `expires_at`); `GET /api/providers/<handle>/model-gaps` (`?model=`, `?upstream_key=`) lists a Provider's, and the summary includes them. A gap ends by itself 24 hours after it was recorded, when a key test of the key passes, and when the key's name, secret or Endpoint restriction is edited (enabling or disabling does not clear it). Clear gaps by hand with `POST /api/providers/<handle>/keys/<key>/clear-model-gaps` or, for selected keys, `POST /api/providers/<handle>/keys/bulk/clear-model-gaps` `{"items": ["key-1", ...]}`; both take `?model=` to clear one model only and `dry_run`, and are audited, so reverting the Audit Entry restores the gaps. When every usable key has a gap for the model, Callers get `404 model_unavailable` at once. Creation, clearing and expiry are logged as `model_gap` (`op` created, cleared, expired).

**Key test.** `POST /api/providers/<handle>/keys/<key>/test` sends a tiny real chat call ("Reply with the word OK.", at most 16 tokens) with the key on the first Endpoint it may use (or `?endpoint=<name>`), in that Endpoint's Shape and auth style and with its renames, using `?model=` or the model of the Provider's latest successful Request. A pass makes an invalid or cooling key active and clears its Model Gaps; a failure goes through the Failure Rules like any Attempt, and so does an error sent inside a 2xx answer (MiniMax's `base_resp`, an `error` object in a 200), which fails the test. `POST /api/providers/<handle>/keys/bulk/test` tests many keys (5 at a time). Both take `dry_run`.

**Provider summary.** `GET /api/providers/<handle>/summary` gives key counts per Key State, every cooling with its end time, every Model Gap, when the next key is usable, the effective budget, and the failure rate of the last hour's Attempts.
