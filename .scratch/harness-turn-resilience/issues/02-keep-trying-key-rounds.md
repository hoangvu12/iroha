# Keep trying: revisit the eligible Key pool in rounds

Status: done
Blocked by: 01

## Acceptance

- [x] When every eligible Upstream Key has been tried and the last Failure Classification is transient, a Request starts another round over the pool instead of returning an error.
- [x] Attempted-key exclusion resets per round; same-key attempt counters are honored across rounds.
- [x] A round only starts while the current round number is under the attempt budget and elapsed time is under `totalRetryTimeoutMs`.
- [x] A new round sleeps with backoff before retrying, so a transient condition is not hammered.
- [x] Genuinely terminal classifications still end the Request immediately.
- [x] The first round still visits every eligible key, so existing failover coverage is preserved.
- [x] Focused HTTP tests cover: a transient condition that clears on a later round, and round-budget exhaustion.
- [x] The transient terminal reports the last real upstream failure (5xx / 429) with its retry timing, not a misleading `upstream_credentials_unavailable`.

## Comments

`startNextRound` lives in both route forwarders (`src/http/inference.ts`). Rounds are gated on `transientRetry` (capacity_limited or provider_failure only), `!authoritativeExhaustionKnown`, the round number being under `retryMaxAttempts`, and the total budget. Network failures deliberately do **not** round: they keep the existing `retryAmbiguousNetwork` duplicate-safety opt-in, and the caller's own retry (opencode retries 502) covers them.

`totalRetryTimeoutMs` default rose from 30s to 120s in `DEFAULT_TRANSPORT` and the Provider create path. Rows created earlier keep their stored value; 30s is still enough for three quick rounds, and it can be raised per Provider via the admin API.