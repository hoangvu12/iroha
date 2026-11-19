# 14: OpenAI Responses Shape

**What to build:** Callers can use `/v1/responses` (global and provider-scoped) against Endpoints of any supported Shape, and Endpoints speaking Responses can serve Callers of any Shape, streamed and not, with tools, reasoning and usage carried across.

**Blocked by:** 13

**Status:** ready-for-agent

- [ ] Golden tests for Responses to and from every other Shape, including stream events
- [ ] Passthrough when the Endpoint speaks Responses
