# 32: Record the model the upstream says it served

**What to build:** Callers get their requested name echoed (spec story 16), and Requests/Attempts keep only `wire_model`, so the model the upstream reports (a dated snapshot, OpenRouter `openrouter/auto` resolving to a concrete model) is lost (catalog MOD-06). Read it where `passRelay` and translation already find the model for the echo (buffered and streamed, every Shape), store it on the Attempt as `reported_model` (migration `32_01_...`), and show it in `/api/requests/{id}` and the Requests drawer (`pages/requests/attempt-info.ts`). Callers keep seeing their requested name.

**Blocked by:** none

**Status:** done

- [x] Gateway test: upstream answers `gpt-x-2026-01-01` (buffered and streamed); the Attempt records it, the Caller still sees its own name
- [x] Shown on the Requests page Attempts tab

## Comments

`gateway/reported.go`: a `reportedModel` reader per Attempt, fed the upstream answer in the Endpoint's Shape next to the `usage.Reader` (passRelay body/data, `translatedBody`, `relayTranslatedStream`), so passthrough and translation read it before any echo. Per Shape: top-level `model` (Chat, and Anthropic/Responses bodies), `message_start.message.model`, the `response` object of Responses events, Gemini `modelVersion`; the first one found is kept (cut to 256 bytes). Stored as `attempts.reported_model` (migration `32_01_reported_model.sql`), returned on `GET /api/requests/{id}` attempts (omitted when empty), logged on the `attempt` event when it differs from `wire_model`. UI: `servedModel(a)` in `attempt-info.ts`; "Model served" row in the Attempts tab and the Route view panel when it differs from the model sent. Testkit: `Upstream.SetServedModel(m)` makes the fakes' answers name `m`. Test `gateway TestTheAttemptRecordsTheModelTheUpstreamSaysServedIt` covers 4 Endpoint Shapes x 4 Caller Shapes x buffered/streamed. Not on the Request row itself (the feed shows `wire_model`); add it there if the feed should filter on it.
