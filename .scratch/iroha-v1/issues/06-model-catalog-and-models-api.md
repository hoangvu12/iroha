# 06 — Model catalog and scoped Models API

**What to build:** Provider Connections maintain an explainable cached model catalog and expose an OpenAI Models response filtered by the caller's Key Scope.

**Blocked by:** 03 — Generic Provider Connection with one encrypted Upstream Key; 04 — Scoped Gateway Keys and Provider Directory.

**Status:** ready-for-agent

- [ ] A connection can synchronize models after creation/edit and through an explicit Owner refresh action.
- [ ] The catalog merges last upstream discovery, Provider Template knowledge, Owner additions, Owner exclusions, and capability overrides.
- [ ] The UI identifies model provenance, freshness, last success, and the latest synchronization failure.
- [ ] A failed refresh retains the last successful catalog, marks it stale, and does not disable inference.
- [ ] Provider-scoped Models returns an OpenAI-shaped list of exact model IDs permitted by the calling Gateway Key.
- [ ] Unknown catalog models remain forwardable on provider-scoped inference unless Key Scope or an Owner exclusion forbids them.
- [ ] Connection capability defaults and per-model overrides represent Chat, streaming, tools, structured output, and Responses support.
- [ ] HTTP and browser tests cover refresh success/failure, stale retention, source merging, overrides, and scope filtering.

