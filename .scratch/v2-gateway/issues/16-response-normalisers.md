# 16: Response and request normalisers for provider quirks

**What to build:** Provider quirks that rewrite content rather than classify failures, applied on passthrough and translated paths and on streams: `<think>` text moved into reasoning, non-standard content blocks flattened so messages are not empty, fields a Provider rejects on replayed turns dropped (such as Anthropic message IDs sent to OpenAI-shaped or Mistral Endpoints), streams ending without a finish reason closed cleanly. Every content-rewriting case in `docs/research/v1-case-catalog.md` is covered.

**Blocked by:** 13

**Status:** done

- [x] Each normaliser has a test with a recorded upstream response or request
- [x] Normalisers apply per Provider and are listed in the Provider summary
- [x] Catalog content-rewriting cases all mapped

## Comments

Built `internal/normalise` (pure, table-tested in `normalise_test.go` with v1's recorded bodies) and hooked it into `internal/gateway/attempt.go`: request normalisers run on the body sent to the Endpoint (passthrough or translated); response normalisers run on the Endpoint's answer before it is passed through or translated (`normaliseBody` for whole answers, `normaliseEvent` in `relayStream`, and before `translate.Stream.Event` in `relayTranslatedStream`; `Stream.End` on a body that ended without a transport error). An answer no normaliser changes keeps its bytes. End-to-end tests: `internal/gateway/normalise_test.go`. Agent docs: `internal/api/skill/22_normalisers.md`; architecture: "Ticket 16: normalisers".

Normalisers (all for OpenAI Chat Endpoints; the catalog needs none for Anthropic Endpoints):

| Name | Side | Hosts | What |
|---|---|---|---|
| `chat-reasoning-tags` | response | all | Leading `<think>`/`<thinking>`/`<budget:thinking>` block → `reasoning_content`, whole and streamed (tags split across chunks held back, flushed before the finish); content echoing the native reasoning field blanked |
| `chat-content-blocks` | response | all | GLM content array (thinking + text blocks) → string content + `reasoning_content` |
| `chat-vendor-fields` | response | all | Drops `audio_content` and a brand `name` (MiniMax) |
| `chat-finish-reason` | response | all | Stream ended cleanly (`[DONE]` or end of body) with no `finish_reason`: closing chunk (`stop`, or `tool_calls`) before the usage chunk / `[DONE]`, then `[DONE]` |
| `zai-finish-reasons` | response | `z.ai,bigmodel.cn` | `sensitive` → `content_filter`, `model_context_window_exceeded` → `length`, `network_error` → failed Attempt (whole answer, retried elsewhere) or `upstream_stream_error` (stream) |
| `chat-replayed-fields` | request | all | Drops a message's `id` (replayed Anthropic message id) |

Selection: by Endpoint Shape and, for a service's own vocabulary (Z.ai's finish reasons), by Endpoint host, as ticket 07 does for built-in Failure Rules. Model quirks (`<think>`, GLM blocks, MiniMax fields) apply on every host because relays, OpenRouter and self-hosted servers pass them on; each acts only when its construct is present. `GET /api/providers/{provider}/summary` lists the applying normalisers with the Endpoints they apply to (`normalisers`). Normalisers are not Owner-configurable (code, per ADR-0005).

Deliberate differences from v1: a `<think>` block is lifted only when it opens the text (v1 lifted the first block anywhere and dropped the text before it; a tag later in the text is now the model's own words). With OpenRouter's `reasoning` field, text after the echoed reasoning is kept rather than blanked. A Chat stream the Provider ends cleanly without any `finish_reason` is now closed (REQ-66/REQ-73's "don't invent an end" still holds for streams that break off: `upstream_stream_broken`). `TestStreamUsageReachesCallersWhoAskForItAndModelsAreEchoed` (gateway_test.go) got a `finish_reason` in its fixture so it still tests byte-preservation.

### Catalog mapping (for ticket 26)

Unit tests are in `internal/normalise/normalise_test.go`, end-to-end in `internal/gateway/normalise_test.go`.

| Catalog ID | Covered by | Test |
|---|---|---|
| REQ-22 | All normalisers return the body unchanged when nothing needs normalising (invalid JSON, no/empty choices, error envelopes) | `TestWholeAnswers` (REQ-22 rows); `TestPassthroughStaysByteForByteWhenNoNormaliserActs` |
| REQ-23 | `chat-vendor-fields` | `TestWholeAnswers` (vendor rows), `TestStreams` (first case); `TestThinkTextMovesIntoReasoningOnEveryPath` |
| REQ-24 | `chat-content-blocks` | `TestWholeAnswers` (GLM), `TestStreams` (GLM); `TestGLMContentBlocksAreFlattened` |
| REQ-25, REQ-26, REQ-27 | Not normalisers: gateway relay (04, 17). A non-SSE answer to a stream request goes the whole-answer way and is normalised as such | existing gateway tests |
| REQ-30 | Not a normaliser (Responses, ticket 14); no normaliser touches Responses events | — |
| REQ-37 | Normalisers run before translation | `TestThinkTextMovesIntoReasoningOnEveryPath` (Anthropic Caller, whole and streamed), `TestGLMContentBlocksAreFlattened` |
| REQ-53 | `chat-replayed-fields` (passthrough) and translation (RelayKit's DTO drops it) | `TestReplayedMessageIDsAreDropped`; `TestReplayedMessageIDsNeverReachAChatEndpoint` (v1 body, Mistral host, both paths) |
| REQ-61 | `chat-content-blocks` + `chat-reasoning-tags` before translation; `reasoning_content`/`reasoning` → thinking by translation (13) | `TestGLMContentBlocksAreFlattened`, `TestThinkTextMovesIntoReasoningOnEveryPath`; golden `anthropic-to-chat-tools-images-thinking` |
| REQ-65 | Stream normaliser passes comments, non-JSON and error events verbatim; `[DONE]` once | `TestStreamPassesOtherEventsUntouched` |
| REQ-66, REQ-73, REQ-76 | Broken streams still end as broken; clean end without finish closed by `chat-finish-reason` | `TestStreamsEndingWithoutAFinishReasonAreClosed` (last part), `TestStreamsWithoutAFinishReasonAreClosed` |
| REQ-85 | `chat-reasoning-tags` (whole) | `TestWholeAnswers`, `TestEveryChoiceIsNormalisedOnItsOwn` |
| REQ-86 | `chat-reasoning-tags` (stream, per choice, split tags, held text flushed before the end) | `TestStreams`, `TestHeldTextGoesOutBeforeTheEnd`; `TestThinkTextMovesIntoReasoningOnEveryPath` |
| REQ-87 | `chat-reasoning-tags` leaves native `reasoning_content`/`reasoning` alone | `TestWholeAnswers`, `TestStreams` |
| REQ-88 | `chat-reasoning-tags` blanks echoed reasoning | `TestWholeAnswers`, `TestStreams` (OpenRouter case) |
| REQ-89 | Translation (13), not a normaliser | golden `chat-to-anthropic-tools-images-reasoning` |
| FAIL-22 | `zai-finish-reasons` (07 had deferred it to 17, which did not take it) | `TestZaiFinishReasons` (both files) |
| FAIL-33 | Replayed `id` dropped by `chat-replayed-fields`; other unknown fields (`store`, `verbosity`) are not stripped and a 422 is reported by the Failure Rules (07) | `TestReplayedMessageIDsNeverReachAChatEndpoint` |
| FAIL-79 / top-10 #10 | Error events pass the normalisers verbatim; classification of streamed error bodies is 07's (`embedded.go`) | `TestStreamPassesOtherEventsUntouched` |
| (history: streams ending without `finish_reason`) | `chat-finish-reason` | `TestStreamsWithoutAFinishReasonAreClosed`; `TestStreamsEndingWithoutAFinishReasonAreClosed` |

Not done: which normaliser changed an answer is not recorded on the Attempt (would need a column); no Anthropic-Endpoint normalisers (none in the catalog).
