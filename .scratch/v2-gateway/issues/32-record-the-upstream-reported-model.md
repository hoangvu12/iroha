# 32: Record the model the upstream says it served

**What to build:** Callers get their requested name echoed (spec story 16), and Requests/Attempts keep only `wire_model`, so the model the upstream reports (a dated snapshot, OpenRouter `openrouter/auto` resolving to a concrete model) is lost (catalog MOD-06). Read it where `passRelay` and translation already find the model for the echo (buffered and streamed, every Shape), store it on the Attempt as `reported_model` (migration `32_01_...`), and show it in `/api/requests/{id}` and the Requests drawer (`pages/requests/attempt-info.ts`). Callers keep seeing their requested name.

**Blocked by:** none

**Status:** ready-for-agent

- [ ] Gateway test: upstream answers `gpt-x-2026-01-01` (buffered and streamed); the Attempt records it, the Caller still sees its own name
- [ ] Shown on the Requests page Attempts tab
