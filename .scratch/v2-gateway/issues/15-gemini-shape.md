# 15: Gemini Shape

**What to build:** Callers can use Gemini `generateContent` and `streamGenerateContent` (model in the URL path; `x-goog-api-key` header or `key` query parameter accepted) against Endpoints of any supported Shape, and Gemini Endpoints can serve Callers of any Shape, with tools, images, reasoning and usage carried across.

**Blocked by:** 13

**Status:** ready-for-agent

- [ ] Golden tests for Gemini to and from every other Shape, streams included
- [ ] Gemini Caller auth styles accepted and stripped before forwarding
- [ ] Qualified and Pool model names work in the Gemini URL path
