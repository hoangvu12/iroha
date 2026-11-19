# 11: Model metadata for clients

**What to build:** Every listed model carries context window, max input, max output, modalities, reasoning support and levels, and `chat:"ok"` unless known not to chat. Facts come from Owner overrides, then the Provider's own list (normalising common field aliases and nested shapes), then models.dev (exact, dot-versus-dash, bare name with a single numbered release; looked up by the Provider's models.dev brand; cached; failure leaves fields blank). Metadata never affects listing or routing.

**Blocked by:** 10

**Status:** ready-for-agent

- [ ] Precedence covered by table tests of the metadata module
- [ ] No fuzzy prefix matching; ambiguous matches leave fields blank
- [ ] Owner overrides through the API
- [ ] A models.dev outage never fails discovery
