# 26: v1 conformance checklist

**What to build:** A checklist beside the spec that maps every essential behaviour and provider quirk in `docs/research/v1-case-catalog.md` to the v2 test that covers it, or marks it not applicable with a reason (for example cases that existed only because of v1's per-key allow-lists). Missing coverage is added as tests or filed as new tickets.

**Blocked by:** 07, 11, 14, 15, 16, 17, 18, 20

**Status:** done

- [x] Every catalog case of kind essential or provider quirk has a test reference or a not-applicable reason
- [x] Cases v1 got wrong are covered by tests that assert the correct behaviour
- [x] Gaps found are filed as tickets in this folder

## Comments

**Checklist:** `.scratch/v2-gateway/conformance.md`. 521 cases (418 a, 103 b): 388 covered, 95 n/a, 17 ui (tickets 21–25), 13 partial and 8 open, each pointing at a ticket. Every test reference (899) was checked against the code by a script when the file was written (kept outside the repo, `iroha-v2-notes/t26/build.ps1`). The file also collects the deviations from v1 worth an Owner decision (retention minimum 1 day from 19; streams closed without a finish reason from 16; Z.ai 1311 → Model Gap and 1315 → invalid from 07; upstream error text reaching Callers; the global sign-in lock; create-or-update on a taken Provider handle; and others).

**Tests added** (72 new top-level tests plus table cases; each starts its doc comment with the catalog IDs): `internal/gateway/conformance_test.go` (headers, redirects, Caller disconnects, stream edge cases, revocation mid-stream), `keystates_conformance_test.go` (claims never shortened, escalation window, restart, key tests on disabled or billing-cooled keys, bulk tests 5 at a time, dead Endpoint failover, plan fixed per Request), `conformance_messages_test.go` (Anthropic envelopes, CRLF streams, broken streams on `/v1/messages`); `internal/translate/conformance_test.go`; `internal/models/conformance_test.go`, `internal/providers/conformance_test.go`, `internal/modelrefresh/conformance_test.go`, `internal/jobs/overlap_test.go`, `internal/modelmeta/timeout_test.go`; `internal/server/run_test.go`; plus cases in the session, retention, config, gatewaykeys, requests, webui, rules, planner and `cmd/iroha` tests.

**Behaviour fixed** (each was wrong; the checklist's "Fixed by ticket 26" table names the test):
- FAIL-49: Failure Rule `body` conditions read a JSON body's error fields only (raw text otherwise), so a 403 echoing a `"model"` field is no longer a Model Gap. Applies to Owner rules too; skill and OpenAPI text updated.
- FAIL-104: the planner orders keys by health first (cooling ended, no success since → after the others), then carriers. `TestFailedAttemptsMoveOnToOtherKeysAndEachExplainsItself` was adjusted for the new order. Architecture: "Ticket 26: key order".
- REQ-62, REQ-48: a non-JSON 2xx on a translated Attempt is a failed Attempt (retry elsewhere) instead of ending the Request with `translation_failed`.
- REQ-97: Iroha's OpenAI error type for 429 is `rate_limit_error`.
- REQ-47, REQ-60: unknown stop/finish reasons mapped, tool calls end `tool_calls`, missing tool ids minted.
- MOD-69: a model listed without metadata keeps its earlier facts.
- USE-22: a model-list error body echoing the key is scrubbed before it reaches results, logs or the console.
- AUTH-09: `Secure` cookie from the first `X-Forwarded-Proto` value. AUTH-11, USE-67: retention deletes ended Owner sessions after `retention.logs_days`. CFG-03: every bad startup value reported together.

**Filed:** 29 (spread over Endpoints), 30 (structured output, `search_result` blocks), 31 (idempotency key, replay pause), 32 (record the upstream-reported model), 33 (model display names), 34 (duplicate Endpoint URLs; ticket 27's re-runnable import needs it), 35 (mask static headers in Audit Entries), 36 (compression), 37 (concurrent admin edits), 38 (metrics), 39 (backpressure test). Most are `needs-decision`. KEY-14 (Gateway Key delete) was going to be a ticket until ticket 24 merged `DELETE /api/gateway-keys/{key}`; `requests TestDeletingAGatewayKeyKeepsItsRequests` now asserts history survives it.

**For ticket 22:** `POST /api/providers` with a taken handle updates that Provider (create-or-update), so the create dialog must check the handle first.
