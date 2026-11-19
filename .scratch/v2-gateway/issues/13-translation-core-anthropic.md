# 13: Shape translation core with Anthropic Messages

**What to build:** Callers can use Anthropic Messages (`/v1/messages`, global and provider-scoped, `x-api-key` accepted) against OpenAI Chat Endpoints and OpenAI Chat against Anthropic Endpoints, streamed and not, with tools, images, reasoning/thinking and usage carried across. Translation goes through one canonical form behind a single interface; the library (RelayKit or Bifrost core) is chosen by golden tests built from recorded request and response pairs, and the choice is noted in ADR-0004. Same-Shape requests still pass through untouched.

**Blocked by:** 09

**Status:** ready-for-agent

- [ ] Golden tests for both directions, including streams, tool calls, images and reasoning
- [ ] Reasoning effort translated between Shapes
- [ ] Planner uses translation when no same-Shape Endpoint has a candidate
- [ ] Request records Shape in and Shape out
- [ ] Library choice recorded with the golden-test results
