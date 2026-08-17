# 01 — Green the suite, clean the repo, and merge the Provider Pack work to main

**What to build:** `bun test` currently reports 25 failures across 1141 tests. All 25 come from two untracked work-in-progress files, `test/http/inference-anthropic-tools.test.ts` and `test/http/inference-anthropic-streaming.test.ts`, and every one is the same error: their `createAnthropicConnection` helper posts a Provider without a `handle`, which ADR-0017 made required. The green suites already do it correctly (`test/http/providers.test.ts:77`). No committed work is red.

Fix the helper in both files, clean up two pieces of repo hygiene, then land the branch. `stdout.log` and `stderr.log` are runtime logs tracked in git and modified on every run, and `.gitignore` covers neither them nor `.scratch/`.

`feat/provider-packs` is six commits ahead of `main` and zero behind, with no remote configured, so the merge is a local fast-forward that publishes nothing.

**Blocked by:** None — can start immediately.

**Status:** complete

- [x] Both Anthropic test helpers post a `handle`, following the naming convention in `test/http/providers.test.ts`.
- [x] `bun test` reports zero failures.
- [x] `bun run typecheck` passes.
- [x] `stdout.log` and `stderr.log` are untracked via `git rm --cached`, and `.gitignore` covers `*.log`. **`.scratch/` is not ignored** — see Comments.
- [ ] ~~The two `.scratch/` files currently tracked are also untracked.~~ Withdrawn by the Owner — see Comments.
- [x] The working tree's source changes, new tests, six new ADRs, five research documents and `scripts/` are committed to `feat/provider-packs`, as `005a46a`. `.scratch/` is committed too, per the Owner's decision.
- [x] `main` is fast-forwarded to `feat/provider-packs`.
- [x] A `feat/optimistic-updates` branch exists off the merged `main`.

## Comments

**The 25 failures had a second cause this ticket did not name.** Adding the
`handle` fixed the Provider create, but every test then failed on
`upstream.calls[0]` being `undefined`: both files build their inference path
as `/providers/${connection.id}/v1/chat/completions`, and ADR-0017 made the
Handle — not the ID — the public routing identity, so every request returned
`400 invalid_provider_handle` without reaching the stub transport. Both files
now route by `connection.handle` and declare `handle` on `ConnectionBody`.
Gateway Key scope entries still carry `providerId`; that surface is unchanged.

**`.scratch/` stays in version control.** The ticket said two `.scratch/`
files were tracked; in fact about 110 are — the full issue tracker for eleven
features. Asked whether to untrack all of it, the Owner chose to leave
`.scratch/` versioned, so neither the `.gitignore` entry nor the untracking
was applied. Only the two runtime logs were untracked.

**A remote does exist.** The ticket said none was configured, but `origin`
points at `github.com/hoangvu12/iroha` and `main` is now eight commits ahead
of `origin/main`. The merge was still purely local — nothing was pushed.
