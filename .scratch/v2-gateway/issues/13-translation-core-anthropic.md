# 13: Shape translation core with Anthropic Messages

**What to build:** Callers can use Anthropic Messages (`/v1/messages`, global and provider-scoped, `x-api-key` accepted) against OpenAI Chat Endpoints and OpenAI Chat against Anthropic Endpoints, streamed and not, with tools, images, reasoning/thinking and usage carried across. Translation goes through one canonical form behind a single interface; the library (RelayKit or Bifrost core) is chosen by golden tests built from recorded request and response pairs, and the choice is noted in ADR-0004. Same-Shape requests still pass through untouched.

**Blocked by:** 09

**Status:** done

- [x] Golden tests for both directions, including streams, tool calls, images and reasoning
- [x] Reasoning effort translated between Shapes
- [x] Planner uses translation when no same-Shape Endpoint has a candidate
- [x] Request records Shape in and Shape out
- [x] Library choice recorded with the golden-test results

## Comments

Built `internal/translate` (RelayKit v0.3.7 behind `New`/`Request`/`Response`/`Stream`, one codec per Shape so 14 and 15 add codecs only), with Iroha's host work around it: tool-name sanitising and restoring, image URLs passed as Anthropic URL sources (nothing downloaded), clean usage, chunk stamping, SSE framing, upstream error events and cut streams as Iroha errors, default `max_tokens` toward Anthropic. Golden tests in `internal/translate/testdata/golden/` (4 cases, both directions, whole and streamed); results in ADR-0004.

Gateway: `POST /providers/{handle}/v1/messages` (passthrough to Anthropic Endpoints with `anthropic-version` defaulted, translation otherwise), Anthropic error envelope and `streamShape` (ping keep-alives, `event: error`); Chat Completions now translates to Anthropic Endpoints too. Planner: other-Shape Endpoints are a second tier via `Request.Translate` (small change in `endpointTiers`). Usage per Shape in `usage.Reader` (Anthropic merges `message_start` and `message_delta`); captures of Anthropic streams reassembled into one message. `x-api-key` Caller auth already worked (ticket 04).

Deferred: the global `/v1/messages` route needs ticket 12's `handle/model` addressing (12 can mount `serveScoped` for it). Translation diagnostics from RelayKit (`Translation.Diagnostics`) are not yet stored on the Attempt. `max_tokens` defaults by model family (opus/sonnet/haiku, else 4096) until model metadata (11) can supply real limits. Normalisers are ticket 16 (hook point described in `docs/agents/architecture.md`).
