# 12: Global routes and Gateway Key scopes

**What to build:** Global `/v1/...` routes accept `handle/model`, split at the first slash. Gateway Keys can be scoped to all, or to chosen Providers each optionally narrowed to models. Global `/v1/models` lists exactly what the key may use, qualified, with metadata, from one batched read. Anything out of scope gets the uniform refusal.

**Blocked by:** 11

**Status:** ready-for-agent

- [ ] Unqualified names that are not Pools are refused with a hint
- [ ] Model IDs with slashes after the handle work end to end
- [ ] Global `/v1/models` answers well under 3 s with 2k models
- [ ] Response model field echoes the requested qualified name
