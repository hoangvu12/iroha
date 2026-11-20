# 04: Conversation IDs on every Attempt, passthrough included

Status: done
Blocked by: none (01–03 done)

## Why

Callers like Pi send their conversation only in `Iroha-Session`, which Iroha reads for Conversation Affinity (02) and never forwards. Ticket 03 adds a derived `prompt_cache_key` only on **translated** Attempts. Same-Shape passthrough, which carries almost all production traffic (Pi → gpt relays and minimax, OpenAI Chat → OpenAI Chat), reaches the Provider with no conversation ID at all. Prompt caching there works on the prompt's prefix alone. An ID lets the Provider or relay send the conversation to the machine or upstream account that holds its cache.

The Owner wants this for every Provider and relay. This ticket changes spec decision "Same-Shape passthrough stays byte-for-byte" (`.scratch/prompt-caching/spec.md`, line 12): update that line to say ticket 04 adds the ID to passthrough.

## What

For every Attempt with a conversation (affinity source not `none`), whatever the Shape and whether passthrough or translated:

1. **Body, OpenAI Chat and OpenAI Responses Endpoints**: add `prompt_cache_key` = `caching.PromptCacheKey(x.affinityKey(provider, model))` when the Caller's body has none, following the Endpoint's existing `send_prompt_cache_key` policy (`caching.For`: default on except strict hosts, `on`, `off`). On passthrough, edit the body with `setField` (`gateway/jsonedit.go`, byte-preserving: the only change is the appended field). Translation keeps doing what 03 does.
2. **Headers, every Shape**: send the same derived value in the headers relays and Providers use to route by session, when the Caller did not send that header: `x-session-affinity` (Fireworks and others, Pi's default form), `x-session-id` (OpenRouter), `session_id` (Codex-style backends and relays built for them). Only `send_prompt_cache_key: off` turns them off; strict hosts still get them (they refuse unknown body fields, not headers). Iroha's own `Iroha-Session` stays stripped.
3. **Never the Caller's own value.** A Caller-sent `prompt_cache_key` or session header is forwarded as is and never overwritten. The value sent is always the derived UUID (scoped to the Gateway Key, Provider and model), never the Caller's raw session string: many Endpoints are third-party relays.

## Nothing that works today may fail

- Body additions on passthrough go in `x.added` like translated ones, so the existing refusal retry (`refusedAddition`, `retryPlain`, `x.plain`, outside the Attempt budget, at most once per Endpoint per Request) covers them.
- On passthrough the only difference from the Caller's body is Iroha's addition. So when a passthrough Attempt with additions fails with 400 or 422, and the Failure Rules' decision would end the Request (the Caller's fault, `fail_request` or equivalent), ask again once on the same key with nothing added (same free retry, `x.plain`), even when `caching.Refused` does not recognise the wording. Failures the rules judge as key or model problems keep their normal handling. When the plain retry also fails, the Caller gets that answer as before. Translation keeps 03's narrower trigger (`TestAnOrdinary400NamingAnAddedFieldIsNotRetried` stays).
- Headers are never the trigger for a retry (unknown headers are ignored in practice); don't add header removal to the retry unless a test shows a reason.

## Also

- `caching.Policy`/`Describe` and the `send_prompt_cache_key` docs (struct tags in `caching.go`, the Endpoint sheet's summary through `caching.summary`) describe the new reach: passthrough too, plus the session headers.
- Package doc comments in `internal/caching` and `gateway/caching.go` ("Passthrough never comes here") updated.
- `docs/agents/architecture.md` "Prompt caching 03" section: add a "Prompt caching 04" section in the same style.
- Served skill `internal/api/skill/21_shapes_caching.md`: what Iroha adds, how to turn it off.
- Conformance: check `.scratch/v2-gateway/conformance.md` for rows about passthrough or caching that this changes.

## Tests (test-first, Go, through `internal/testkit` fake upstreams)

- Replace `TestSameShapePassthroughStaysByteForByteWithCachingOn` with: passthrough body equals the Caller's plus exactly the appended `prompt_cache_key` (Chat, Responses); Anthropic and Gemini passthrough bodies stay byte for byte; with `send_prompt_cache_key: off` every Shape is byte for byte and gets no session headers.
- Caller's own `prompt_cache_key` and each session header are kept and not duplicated.
- No conversation (empty prompt, affinity source `none`): nothing added.
- Same conversation → same value across Requests; different Gateway Key, Provider or model → different value.
- Strict host (`googleapis.com`): headers yes, body field no.
- Passthrough 400 with unrecognised wording → one free plain retry on the same key, which succeeds; the Request succeeds and the Attempt budget is untouched (`max_attempts: 1` case). Plain retry also 400 → Caller gets the 400. A 400 the rules read as a key problem is not retried plain.

## Done when

`go test ./...`, `go vet ./...` and the web tests (`npm --prefix web test` if the UI text changed) pass. Then append a `## Comments` section here listing what changed and the test names. Commit on your branch; don't merge, push or deploy.

## Comments

**Built** (architecture.md, "Prompt caching 04"):

- `internal/caching`: `Policy.SessionHeaders` (`send_prompt_cache_key != off`, every Shape and host, strict hosts included); `SessionHeaderNames` and `SetSessionHeaders` (adds only headers the Caller did not send). `Describe`, the struct-tag docs of `Settings`/`SettingsPatch` and the package comment describe the new reach.
- `internal/gateway/caching.go`: `conversationID` (the derived UUID, shared with `cachingFor`), `passthroughCaching` (appends `prompt_cache_key` with `setField` on OpenAI Chat/Responses passthrough when the body has none, records it in `x.added` with `x.addedPass`), `sessionHeaders`; `refusedAddition(set, c, f)` now returns field and reason and adds the passthrough trigger: a 400/422 that the Failure Rules' `Classify` (through `noCredential`) would end the Request with is retried once without the addition, whatever its wording. `prepare` (attempt.go) uses both; `budget.go` passes the rule set. Log kind `cache_field.refused` description updated.
- Docs: spec line 12; skill `21_shapes_caching.md` (what is added, how to turn it off, the passthrough retry), one sentence each in `21_shapes.md` and `22_responses.md`; conformance REQ-28 and MOD-08 (passthrough deviation); Endpoint form hint and `api.ts` doc comment in the web UI.

**Decisions:**

- `session-id` (Codex's other spelling, which affinity reads) fills the same slot as `session_id`: a Caller sending it does not also get `session_id` with a different value. The ticket names three headers; sending a fourth, different value beside the Caller's own seemed the less safe choice.
- "fail_request or equivalent" is taken as the rules' `fail_request` outcome only (after `noCredential`); every other outcome (cooling, invalid, Model Gap, retry_elsewhere) keeps its normal handling.
- No new field in the Endpoint's read-only `caching` object: the summary says it. `send_prompt_cache_key: off` is the one switch for body and headers, as the ticket says.
- Tests of the Failure Rules elsewhere that expect one upstream 400 to end the Request (`gateway` budget, conformance 422, DashScope quirks; `failurerules`, `providers` overview, `requests` capture) now call `srv.NoConversationIDs(handle)` (new testkit helper) so they still test the rules alone; the passthrough retry itself is covered by the new test. Older byte-for-byte passthrough tests (`TestNonStreamedChatPasses…`, `TestGlobalChatNames…`, `TestResponsesPassThrough…`) compare the body minus the appended key (`callerBytes`, which fails when none was appended).

**Tests** (each written first and seen failing): `caching TestSessionHeadersGoEverywhereUnlessOff`, `TestSetSessionHeadersKeepsTheCallersOwn`; `gateway TestPassthroughAddsTheConversationIDAndNothingElse` (replaces `TestSameShapePassthroughStaysByteForByteWithCachingOn`; Chat and Responses = Caller's bytes + appended key, Anthropic and Gemini byte for byte, session headers on all, `Iroha-Session` not forwarded), `TestPromptCacheKeyOffKeepsPassthroughByteForByte`, `TestTheCallersOwnConversationIDsAreKept`, `TestNoConversationGetsNoConversationID`, `TestPassthroughConversationIDsAreScopedToKeyProviderAndModel`, `TestAStrictHostGetsHeadersButNoBodyField`, `TestAPassthrough400IsAskedAgainWithoutThePromptCacheKey` (`max_attempts: 1` succeeds on the plain retry; plain retry also 400 → Caller gets the 400; billing 400 not retried). `TestAnOrdinary400NamingAnAddedFieldIsNotRetried` still passes.

**Checks**: `go vet ./...`, `go test ./...` (35 packages) pass; `gofmt -l` clean; `npm --prefix web test` 81 files, 482 tests pass.
