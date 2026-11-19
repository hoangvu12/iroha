# 38: Concurrent admin edits

**What to build:** PATCH on audited resources is last-write-wins: two agents editing one Gateway Key (or Provider, key, Pool) overwrite each other silently (catalog KEY-11: v1 checked a revision). Decide between optimistic concurrency (an `If-Match` header or `revision` field on audited resources, 409 `revision_conflict` with the current record on mismatch, implemented once in `internal/audit` `Mutate` so every resource gets it) and accepting last-write-wins because every change is an Audit Entry that can be reverted.

**Blocked by:** none

**Status:** needs-decision

- [ ] If built: audit test with two actors racing one record; conventions skill text (`10_conventions.md`) says how to retry
